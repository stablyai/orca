# Terminal perf reports

The rendered terminal perf programs, scale runner and on-demand workflow were retired.
Their previous alarms have no equivalent replacement or current passing benchmark.
Existing reports can still be inspected with `test:e2e:terminal-perf:summarize`,
`test:e2e:terminal-perf:check-report` and `test:e2e:terminal-perf:html-report`.
These tools analyze historical input; they do not execute a new benchmark.

## Historical runs

The nightly schedule was removed on 2026-10-28. It had failed every night since
at least 2026-10-18 because the workflow ran on Blacksmith, which the
presented-frame guard rejects, and the JSON report hid the error.

The first hosted dispatch afterwards (run 40632739161) passed five scenarios.
It then failed "keeps active interactions responsive at 50 ACK-backpressured
OpenCode PTYs": the median typing latency was 104 ms against a 75 ms budget,
and the remaining scenarios were skipped. Reproduce locally before treating it
as a regression rather than a 4-vCPU runner limit.
