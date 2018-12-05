var requestLib = require('request');
var async = require('async');
var _ = require('lodash');
var pkg = require('./package.json');
var DEFAULT_HEADERS = {
      'user-agent': pkg.name + '/' + pkg.version
};

//helper
var nexter = function () {
      //create 'next' functions which can get thrown away along with their data
      var next = function (arr) {
            var i = next.arrs.indexOf(arr);
            if (i === -1) {
                  next.arrs.push(arr);
                  i = next.arrs.indexOf(arr);
                  next.counts[i] = 0;
            }
            return arr[next.counts[i]++ % arr.length];
      };
      next.counts = [];
      next.arrs = [];
      return next;
};
var avg = function (arr) {
      return Math.round(arr.reduce(function (p, c) {
            return p + c;
      }, 0) / arr.length);
};
var rand = function (arr) {
      return arr[Math.floor(Math.random() * arr.length)];
};

//job class
var Job = {
      opts: '',
      cb: '',
      next: '',
      baseUrls: '',
      request: '',
      running: '',
      startTime: '',
      timesup: '',
      results: [],
      initialize: function(job, callback){
            Job.opts = job;
            Job.cb = callback;
            Job.next = nexter();
            _.bindAll(Job);
            if (!_.isArray(Job.opts.sequence)) return Job.cb("requires a 'sequence'");
            if (typeof Job.opts.maxSockets !== 'number') Job.opts.maxSockets = 5;
            if (typeof Job.opts.connections === 'number') Job.opts.maxSockets = Job.opts.connections;
            if (typeof Job.opts.runs !== 'number') Job.opts.runs = Infinity;
            if (typeof Job.opts.duration !== 'number') Job.opts.duration = Infinity;
            if (Job.opts.runs === Infinity && Job.opts.duration === Infinity) Job.opts.runs = 1;
            if (_.isArray(Job.opts.baseUrls)) Job.baseUrls = Job.opts.baseUrls;
            else if (typeof Job.opts.baseUrl === 'string') Job.baseUrls = [Job.opts.baseUrl];
            else return Job.cb("requires a 'baseUrl'");
            for (var i = Job.baseUrls.length - 1; i >= 0; i--)
                  if (!/^https?:\/\/[^\/]+$/.test(Job.baseUrls[i])) return Job.cb("Invalid origin: '" + Job.baseUrls[i] + "', must be http[s]://host:port");
            Job.request = requestLib.defaults({
                  pool: {
                        maxSockets: Job.opts.maxSockets
                  }
            });
            Job.timesup = false;
            Job.running = 0;
            Job.results = [];
            Job.startTime = Date.now();
            // console.log(Job.opts);
            for (var b = 0; b < Math.min(Job.opts.maxSockets, Job.opts.runs); ++b) Job.runSequence();
            if (Job.opts.duration !== Infinity) setTimeout(Job.stopSequence, Job.opts.duration);
      },
      stopSequence: function () {
            Job.timesup = true;
      },
      runSequence: function () {
            if (Job.timesup) return;
            if (Job.running >= Job.opts.runs) return;
            Job.running++;
            //bind this cookie jar to this sequence
            async.mapSeries(Job.opts.sequence, Job.runRequest.bind(Job, requestLib.jar()), Job.ranSequence);
      },
      ranSequence: function (err, results) {
            if (err) return Job.done(err);
            if (!Job.results) {
                  Job.results = [];
            }
            if (!Job.opts) {
                  Job.opts = {
                        runs: Infinity
                  }
            }
            Job.results.push(results);
            if ((!Job.timesup || Job.results.length < Job.running) && (Job.results.length < Job.opts.runs)) process.nextTick(Job.runSequence);
            else Job.done();
      },
      runRequest: function (jar, reqObj, done) {
            if (!_.isObject(reqObj)) return done("sequence item (#{reqObj}) must be an object");
            reqObj.headers = reqObj.headers || {};
            _.defaults(reqObj.headers, Job.opts.headers, DEFAULT_HEADERS);
            reqObj.timeout = reqObj.timeout || Job.opts.timeout || 5000;
            reqObj.method = reqObj.method || 'GET';
            reqObj.path = reqObj.path || '';
            reqObj.followRedirect = reqObj.followRedirect || false;
            var expect = reqObj.expect || {
                  code: 200
            };
            if (expect.code && typeof expect.code !== 'number') return done("sequence property 'code' must be a number");
            if (expect.match)
                  if (typeof expect.match === 'string') {
                        try {
                              expect._re = new RegExp(expect.match);
                        }
                        catch (e) {
                              return done("sequence property 'match' contains an invalid regex: " + expect.match + ": " + e);
                        }
                  }
                  else return done("sequence property 'match' must be a string");
            if (expect.contains && typeof expect.contains !== 'string') return done("sequence property 'contains' must be a string");
            if (reqObj.forms && _.isArray(reqObj.forms)) reqObj.form = Job.next(reqObj.forms);
            if (reqObj.method === 'GET' && reqObj.form) return done("sequence has method GET and form data");
            var path = reqObj.path;
            var url = Job.next(Job.baseUrls) + path;
            var responseTime = Date.now();
            //cleanse request object
            reqObj = _.pick(reqObj, 'method', 'form', 'headers', 'followRedirect', 'timeout');
            reqObj.url = url;
            reqObj.jar = jar;
            var delay = Job.requestDelay;
            Job.request(reqObj, function (err, res, body) {
                  if (err) err = err.toString();
                  else if (!res) err = '(no response)';
                  else if (expect.code && expect.code !== res.statusCode) err = 'expected code: ' + expect.code + ', got: ' + res.statusCode + ' (for ' + reqObj.method + ' ' + path + ')';
                  else if (expect._re && !expect._re.test(body)) err = 'expected body to match regex: ' + expect._re;
                  else if (expect.contains && body.indexOf(expect.contains) === -1) err = 'expected body to contain string: ' + expect.contains;
                  var results = {
                        responseTime: Date.now() - responseTime
                        , err: err
                  };
                  if (delay) setTimeout(done.bind(null, null, results), delay);
                  else done(null, results);
            });
      },
      done: function (err) {
            if (err) return Job.cb(err);
            var finalResults = {
                        paths: {}
                        , errors: {}
                        , pass: 0
                        , fail: 0
                        , total: 0
                        , totalTime: Date.now() - Job.startTime
                  }
                  , finalTimes = []
                  , s, r, res, req, path, pathData;
            for (s = 0; s < Job.opts.sequence.length; ++s) {
                  var reqObj = Job.opts.sequence[s]
                        , key = reqObj.method + " " + reqObj.path
                        , times = [];
                  //add to path
                  if (finalResults.paths[key]) pathData = finalResults.paths[key];
                  else pathData = finalResults.paths[key] = {
                        pass: 0
                        , fail: 0
                        , total: 0
                        , times: []
                  };
                  //calculate
                  for (r = 0; r < Job.results.length; ++r) {
                        res = Job.results[r][s];
                        if (!res) res = {
                              err: '(missing)'
                        };
                        pathData.total++;
                        if (!res.err) {
                              pathData.pass++;
                        }
                        else {
                              if (finalResults.errors[res.err]) finalResults.errors[res.err]++;
                              else finalResults.errors[res.err] = 1;
                              pathData.fail++;
                        }
                        pathData.times.push(res.responseTime);
                  }
            }
            //calculate totals
            for (path in finalResults.paths) {
                  pathData = finalResults.paths[path];
                  pathData.avgResponseTime = avg(pathData.times);
                  //delete array
                  delete pathData.times;
                  finalTimes.push(pathData.avgResponseTime);
                  finalResults.pass += pathData.pass;
                  finalResults.fail += pathData.fail;
                  finalResults.total += pathData.total;
            }
            finalResults.avgResponseTime = avg(finalTimes);
            Job.results = [finalResults];
            Job.cb(null, finalResults);
      }
}

//job runner
module.exports = function (job, callback) {
      module.exports.jobs.push(Job.initialize(job, callback));
};
module.exports.jobs = [];
