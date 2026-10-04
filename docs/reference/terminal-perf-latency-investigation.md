# Terminal latency investigation (2026-09-21)

The September 21 scheduled report has five latency violations: three restores
above 1,000 ms, a worst key around 2,091 ms, and timer drift around 2,034 ms.
These remain failures under the [historically calibrated budgets](terminal-perf-report-budgets.md).
Passing the looser Electron assertions does not establish that the report passed.

## Historical boundary

Slow restores predate September: the July 20 scheduled run measured a 1,226.6 ms
Latin restore; August 1 measured 1,492 ms. Earlier June/July logs did not contain
usable summary rows and their artifacts expired. There is no established good/bad
application revision boundary, and no completed git bisect. A newly visible report
failure is not, by itself, evidence of a newly introduced application regression.

The scheduled workflow uses one Playwright worker. Parallel Electron workers do
not explain these particular failures. Repeated macOS runs did not reproduce the
Linux stalls (15 targeted samples: restore 136–236 ms, hidden worst key ≤23.6 ms).

## Controlled Linux experiments

All comparisons use the same application build within their run, one worker,
real PTYs, and the original terminal workload. Diagnostic tracing can perturb
measurements, so it identifies the mechanism rather than setting new budgets.

| Comparison | Evidence | Finding |
| --- | --- | --- |
| Default versus disabled background throttling | [35657300611](https://github.com/stablyai/orca/actions/runs/35657300611) | 14/20 restores exceed 1 second; four typing measurements approach 1 second. `setBackgroundThrottling(false)` does not remove the stalls. |
| Native browser trace | [35658595456](https://github.com/stablyai/orca/actions/runs/35658595456) | Renderer waits roughly 960–1,010 ms in `LayerTreeHost::WaitForCommitCompletion`. Some typing samples contain consecutive waits. |
| Current flags versus flags preceding `c64777d1bcd` versus SwiftShader | [35659601151](https://github.com/stablyai/orca/actions/runs/35659601151) | All three configurations still trigger undrawn-frame throttling. Reverting the May 26 flags is not a demonstrated fix. |

In the graphics comparison, current flags had one of six restores above 1 second;
the earlier flags had three and a 1,036 ms worst key. SwiftShader had six measured
restores between 301 and 396 ms, but still contained one-second native waits after
the restore measurement ended, and one 202 ms timer-drift violation. Its faster
restore numbers are insufficient evidence of a fix.

## Native mechanism

The trace shows the renderer blocked inside:

```
ProxyMain::BeginMainFrame
  Commit
    ProxyMain::BeginMainFrame::commit
      LayerTreeHost::WaitForCommitCompletion
```

During the gap, Viz repeatedly emits `SendBeginFrameDecision` with
`reason: ThrottleUndrawnFrames` and `should_send: false`. The graphics comparison
recorded 346 such decisions with current flags, 626 with the earlier flags, and
401 with SwiftShader. Raster work was already ready before the wait ended.

The [matching Chromium source](https://github.com/chromium/chromium/blob/150.0.7871.250/components/viz/service/frame_sinks/compositor_frame_sink_support.cc)
limits begin frames to once per second when too many submitted frames remain
undrawn. Input can block the renderer waiting for the next compositor commit;
this is not a one-second xterm parse or proof of a second of CPU consumption.
The same throttle is present in Chromium 148.0.7778.218 (Electron 42.3.3) and
146.0.7680.177. This source comparison does not prove identical runtime behavior.

## Visibility control

[Run 35660847455](https://github.com/stablyai/orca/actions/runs/35660847455)
compared ten hidden-window samples with ten visible-window samples on the same
isolated Xvfb runner, using SwiftShader in both modes. Actual window visibility
was recorded. The background terminal panes remained hidden in both modes.

| Measurement | Hidden window | Visible window |
| --- | ---: | ---: |
| Undrawn-frame throttle decisions | 1,251 | 0 |
| Largest worst-key latency | 3,062.8 ms | 30.5 ms |
| Largest timer drift | 3,111.8 ms | 67.0 ms |
| Restore range | 213.8–1,862.2 ms (9 completed) | 223.4–734.3 ms (10 completed) |
| Electron tests passed | 9/10 | 10/10 |

All ten visible-window samples satisfy the existing latency limits. This isolates
the never-presented Linux test window as the trigger for the reproduced native
stalls. It does not establish a newly introduced application-code regression or
prove that every historical outlier had the same cause.

## Full scale validation

[Run 35662787327](https://github.com/stablyai/orca/actions/runs/35662787327)
passed all 21 scenarios and all 32 strict report rows, with zero skipped,
unexpected, or retried tests. All 21 scenarios recorded successful isolated-display
presentation. This run restored the original graphics flags and removed profiling.

| Metric | Largest measurement | Unchanged report limit |
| --- | ---: | ---: |
| Median typing | 15.5 ms | 25 ms |
| Worst key | 45.7 ms | 300 ms |
| Hidden-output restore | 395.7 ms | 1,000 ms |
| Worktree revisit | 50.3 ms | 300 ms |
| Scroll | 54.7 ms | 150 ms |

Timer drift and queue/drop checks also passed. Coverage includes 100-pane
same-workspace and cross-workspace redraws, 50 real PTYs under held-ACK pressure,
and the original plain/Latin/title/rich-model hidden-output scenarios. No workload
or performance limit changed.

The correction presents the benchmark window only when explicitly enabled inside
`xvfb-run` on a GitHub-hosted Linux runner. Ordinary local automation stays
windowless; production launch policy and hidden-terminal delivery remain unchanged.
For comparable Linux latency evidence, use the Terminal Perf workflow: a never-
presented local Linux window can still encounter the same compositor throttle.
Temporary profiling hooks and the comparison workflow were removed before the PR.
