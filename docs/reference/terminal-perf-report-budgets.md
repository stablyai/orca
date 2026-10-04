# Terminal performance report budgets

The saved-report gate is a performance regression gate, deliberately stricter than
some Electron test timeouts. Passing the Electron suite does not establish that a
slow sample is acceptable. CLI and HTML reports use the same policy in
`config/scripts/terminal-perf-report-budgets.mjs`.

## Historical evidence (2026-09-21)

Sample: 11 full scheduled Ubuntu runs, 32 annotation rows per run, August 1 through
September 21 (352 rows). Runs include failures, rather than selecting only green
runs. These are samples across different revisions and shared runners, not a
controlled A/B experiment or a statistical tail-latency estimate. Original June
logs returned HTTP 410 and could not establish an original baseline.

Values below are milliseconds except peak queue chars (JavaScript character
counts, not process memory bytes). Maximum median spans every typing scenario;
peak queue spans the active/revisit ACK-pressure scenarios.

| Date / run                                                              | Baseline median | Maximum typing median | Latin restore | Hidden 25-pane worst key | Peak queue chars |
| ----------------------------------------------------------------------- | --------------: | --------------------: | ------------: | -----------------------: | ---------------: |
| [2026-08-01](https://github.com/stablyai/orca/actions/runs/30693362353) |            11.7 |                  12.7 |        1492.0 |                     61.2 |          1867776 |
| [2026-08-03](https://github.com/stablyai/orca/actions/runs/30802935899) |             7.1 |                   9.4 |         414.0 |                     12.8 |           294912 |
| [2026-08-15](https://github.com/stablyai/orca/actions/runs/31875140053) |             8.9 |                  13.8 |        1297.5 |                     15.4 |          2523136 |
| [2026-08-24](https://github.com/stablyai/orca/actions/runs/32708128219) |            12.2 |                  12.2 |         463.6 |                     16.3 |          3227648 |
| [2026-09-01](https://github.com/stablyai/orca/actions/runs/33488510218) |             6.6 |                   6.8 |         302.2 |                     11.5 |           360448 |
| [2026-09-07](https://github.com/stablyai/orca/actions/runs/34102348134) |             7.5 |                  11.3 |         328.2 |                    269.6 |          2818048 |
| [2026-09-11](https://github.com/stablyai/orca/actions/runs/34580494139) |             9.5 |                  10.4 |         233.5 |                    186.2 |          2441216 |
| [2026-09-15](https://github.com/stablyai/orca/actions/runs/34948597774) |            10.3 |                  12.6 |         282.2 |                   1178.4 |          2818048 |
| [2026-09-17](https://github.com/stablyai/orca/actions/runs/35201162712) |            10.3 |                  12.7 |        1182.2 |                     15.7 |          2998272 |
| [2026-09-19](https://github.com/stablyai/orca/actions/runs/35432611564) |             7.6 |                  10.3 |         236.7 |                   1435.5 |          2588672 |
| [2026-09-21](https://github.com/stablyai/orca/actions/runs/35579708852) |             7.8 |                  11.6 |        1640.7 |                   2090.6 |          2523136 |

## Decisions

- Median typing: **25 ms**, tightened from 75 ms. The largest observed median was
  13.8 ms, leaving about 81% headroom without accepting a sustained 5x slowdown.
- Worst key: retain **300 ms**, including stress scenarios. Typical per-scenario
  worst-key samples were tens of milliseconds; isolated 1–3 second samples are
  failures to investigate, not a reason to adopt the e2e 3–3.5 second ceiling.
- Revisit: retain **300 ms**. Median of the 11 revisit samples was 160.7 ms;
  the 1,030.2 ms outlier remains a failure.
- Restore: retain **1,000 ms**. Median restore per scenario ranged from 123 to
  493.9 ms. Observed outliers up to 1,706.4 ms do not justify a 4 second budget.
- Timer drift: retain **150 ms** and the pre-existing **3,500 ms** allowance only
  for injected same/cross-workspace redraw scenarios. No new scenario receives
  the broad allowance. This retains the CLI gate's existing policy in HTML too.
- Scroll: retain **150 ms**. Dropped backlogs: retain **zero**.
- Current queue: retain **2 Mi characters** everywhere. Only the transient peak
  in active/revisit ACK-pressure scenarios gets **3.5 Mi characters** (3,670,016).
  The maximum observed peak was 3,227,648 (3.08 Mi), leaving about 14% headroom.
  The old 2 Mi peak budget rejects ordinary deliberately held-ACK bursts; the
  proposed 5 Mi e2e ceiling was unnecessarily loose. Other scenarios keep 2 Mi.

For the linked September 21 report, the two peak-queue failures are corrected;
the three slow restores, worst-key stall, and timer stall still fail. This change
does not claim to fix those stalls or make that run green. Re-evaluate future
budget changes against recorded measurements; do not set limits just above a new
failure or mirror relaxed test timeouts.
