# STA-8667 D3 evidence gate: m4-air run

Measurement only. No production code changed, no harness logic changed, no PR.

## Summary

- Harness commit **586c55387eb9904a082982d347b6421c765863c3** (`AmethystLiang/sta-8667-polling-harness`), detached checkout. All 12 expected sha256 values match.
- Fast probes: 4 files, 17 tests, all passed.
- Smoke: 3 of 3 scenarios rc=0 with JSON.
- Full `specs3.txt`: 66 of 66 scenarios rc=0 with JSON on the first attempt. No reruns were needed. Order D, E, C, A, B, F, parallel 4 throughout (1-minute load 4.3 to 7.3 on 10 cores, never above the core count).
- Pass rules (§15): every D, E, C, A, B row that has a pass rule is PASS, with one exception that is **not measured**: the E rule "after the disconnect the remaining clients' queue ages return to the no-disconnect level within one window" cannot be decided from what the harness writes (whole-run aggregates only). No PASS is claimed for it.
- Group F is report-only in §15, but against the contract numbers the "after" runs are **over**: `finishVisible` max is 1,834 to 2,304 s in all five "after" runs (bare contract 130 s plus slot wait; the harness does not report slot wait), `finishSelected` max is 186 s in `detect-serve-after-n14-c2-seed2` (contract 70 s), and 13 to 18 of 93 to 97 events are counted undetected in every "after" run (0 in the three before/oldclient runs). Start latencies are within 1,810 s / 3,610 s in all runs.
- **Deviations from the local figures**: D3 lanes worst visible wait is 900 to 942 s on the N=50 gate-d3 scenarios here (171 to 347 s at N=14/20), not 471 to 491 s. GHES desktop 10 worktrees hour 4 is 723 -> 42 here (hour 3 is 717 -> 36, the local figure). Serve 14x2 is 380 -> 16 (mixed) and 377 -> 18 (settled). Details in "Comparison with the local figures".
- **Runs are not bit-reproducible on this machine**: a rerun of two scenarios gave different counts (total spawns 604 vs 603 over 3 h; 1,046 vs 1,011 over 24 h, with detection max latencies moving by up to 482 s). See "Reproducibility check". So the counts are not purely a function of the spec line.

## Machine and versions

| Item | Value |
| --- | --- |
| Machine | m4-air: Apple M4, 10 cores (4 performance + 6 efficiency), 32 GB, macOS 27.2 (26B123), Darwin 27.2.0 |
| Node | v26.6.0 (harness written on v26.10.0) |
| vitest | 5.0.5 (same as authoring) |
| pnpm | 12.14.0; `pnpm install --frozen-lockfile` reported the lockfile up to date |
| Run window | 2026-11-12 20:49:15Z to 21:03:09Z (main run), reproducibility rerun 21:04 to 21:05Z |
| Parallel | 4 for every group |
| Other load | Other agents share the machine; 130 to 138 sessions logged in |

## sha256 (all 12 expected values match)

```
5c45d14449fe5e39b335bb533318278a5ec700beb14672207c3614410223bf60  gate-d3.ts
3bf47e88454fce54cf0fe0d0a5d24d8185d7ca6f111fffd2caf39d54fcb66003  gate-lanes.probe.test.ts
34216e0debfc932bffe9d0088ec1d1bed4fb02d862caac8ee7c127741caf8fe8  policy-d3.probe.test.ts
fb23bbd68ab5564ad75255417c79668acee6dafa064de29d2b58247d4247c2c3  policy-d3.ts
80c3e14a98cd2597738b4d97a40157f6ccf5b2870aca49b0a47b2279dba946ff  polling-cost.experiment.test.ts
70c349004eb35b3bcbe07f2a89280e7938c627e90ea5a81beb453a9252dc1b82  polling-d2.experiment.test.ts
bc8a2cb6cd294793275312ab413b8e6ce8deef940b303a1618d8a65db59a8c7a  rate-limit-d3.probe.test.ts
4685190159987701f9f81c9c15e7526bb83eafa0ba43fef595cb65e4ca5e4a8a  rate-limit-d3.ts
bab4308d877d0de403f6655b8edb0ed6bd257fd27cd6b3e29fcee5cc657d9edd  scheduler-d3.probe.test.ts
9cb1ce015076b19d7dd05c38e826563021392bf822dfed8dc07a00a17d2592bd  scheduler-patches.ts
096c1608d033cfbbf8dcddadbf3242d07fb951d16b07dd12845f7414e4f42a20  specs3.txt
d1b3ed5489bf14f0c62ac93d61bc7318b59193ec460507b484e88250b6cb76f0  run-specs.sh
914ace17719b9b23f939c23754165d9d572f13178783b95b9a9a18fc8f8e73da  table3.py
```

`polling-cost.experiment.test.ts` (D1 reference) is listed by the Setup command but has no expected value in the brief.

## Uptime log

```
start 2026-11-12T20:49:15Z 12:49  up 4 days, 12:08, 132 users, load averages: 4.28 3.50 3.07
after-probes 2026-11-12T20:49:32Z 12:49  up 4 days, 12:08, 132 users, load averages: 4.72 3.64 3.14
after-smoke 2026-11-12T20:50:09Z 12:50  up 4 days, 12:09, 131 users, load averages: 5.12 3.86 3.23
group D before 2026-11-12T20:50:21Z par=4 12:50  up 4 days, 12:09, 131 users, load averages: 5.01 3.90 3.26
group D after 2026-11-12T20:52:12Z 12:52  up 4 days, 12:11, 130 users, load averages: 5.17 4.38 3.53
group E before 2026-11-12T20:52:12Z par=4 12:52  up 4 days, 12:11, 130 users, load averages: 5.17 4.38 3.53
group E after 2026-11-12T20:53:16Z 12:53  up 4 days, 12:12, 131 users, load averages: 5.67 4.71 3.71
group C before 2026-11-12T20:53:16Z par=4 12:53  up 4 days, 12:12, 131 users, load averages: 5.67 4.71 3.71
group C after 2026-11-12T20:57:01Z 12:57  up 4 days, 12:16, 131 users, load averages: 7.27 6.55 4.78
group A before 2026-11-12T20:57:01Z par=4 12:57  up 4 days, 12:16, 131 users, load averages: 7.27 6.55 4.78
group A after 2026-11-12T21:00:52Z 13:00  up 4 days, 12:19, 135 users, load averages: 6.85 6.77 5.31
group B before 2026-11-12T21:00:52Z par=4 13:00  up 4 days, 12:19, 135 users, load averages: 6.85 6.77 5.31
group B after 2026-11-12T21:01:38Z 13:01  up 4 days, 12:20, 134 users, load averages: 6.46 6.68 5.35
group F before 2026-11-12T21:01:38Z par=4 13:01  up 4 days, 12:20, 134 users, load averages: 6.46 6.68 5.35
group F after 2026-11-12T21:03:09Z 13:03  up 4 days, 12:22, 137 users, load averages: 5.51 6.33 5.35
```

1-minute load range over the run: 4.28 to 7.27 (10 cores).

## Fast probes

```
 Test Files  4 passed (4)
      Tests  17 passed (17)
   Duration  284ms (transform 33%, setup 29%, tests 26%, worker 10%, import 2%)
```

## Smoke

```
cancel-hidden-n14-c2 rc=0 wall=31s
serve-after-n14-c2 rc=0 wall=31s
ghes-desk-after-n10-focused rc=0 wall=32s
ALL DONE
```

The smoke JSON and logs for these three names were overwritten by the full run (same scenario names, same spec lines).

## Group wall times

```
=== GROUP D regex=^lanes- parallel=4 start=2026-11-12T20:50:21Z
=== GROUP D wall=111s end=2026-11-12T20:52:12Z
=== GROUP E regex=^(timeout|cancel)- parallel=4 start=2026-11-12T20:52:12Z
=== GROUP E wall=64s end=2026-11-12T20:53:16Z
=== GROUP C regex=^serve- parallel=4 start=2026-11-12T20:53:16Z
=== GROUP C wall=225s end=2026-11-12T20:57:01Z
=== GROUP A regex=^ghes-desk- parallel=4 start=2026-11-12T20:57:01Z
=== GROUP A wall=231s end=2026-11-12T21:00:52Z
=== GROUP B regex=^dotcom- parallel=4 start=2026-11-12T21:00:52Z
=== GROUP B wall=46s end=2026-11-12T21:01:38Z
=== GROUP F regex=^detect- parallel=4 start=2026-11-12T21:01:38Z
=== GROUP F wall=91s end=2026-11-12T21:03:09Z
```

Total wall for the six groups: 768 s (12 min 48 s). Per-scenario wall 19 to 56 s; vitest itself reported 2.6 s for a 4 h `serve-after` N=14 and 5.8 s for a 24 h `detect-serve-after`. The F group never came near the 4-hour interim-report threshold (91 s).

## Per-scenario exit code, JSON, wall time

| Group | Scenario | rc | JSON | wall s | counts |
| --- | --- | --- | --- | --- | --- |
| D | `lanes-4sel-n50-c4-gate-d2` | 0 | yes | 40 | yes |
| D | `lanes-4sel-n50-c4-gate-d3` | 0 | yes | 39 | yes |
| D | `lanes-4sel-checks-n50-c4-gate-d2` | 0 | yes | 39 | yes |
| D | `lanes-4sel-checks-n50-c4-gate-d3` | 0 | yes | 39 | yes |
| D | `lanes-2sel-n50-c2-gate-d2` | 0 | yes | 40 | yes |
| D | `lanes-2sel-n50-c2-gate-d3` | 0 | yes | 38 | yes |
| D | `lanes-1sel-checks-n14-c2-gate-d3` | 0 | yes | 39 | yes |
| D | `lanes-1sel-checks-n50-c2-gate-d3` | 0 | yes | 39 | yes |
| D | `lanes-2sel-checks-n14-c2-gate-d3` | 0 | yes | 28 | yes |
| D | `lanes-4sel-checks-n20-c4-gate-d3` | 0 | yes | 30 | yes |
| D | `lanes-fg-n50-c4-gate-d3` | 0 | yes | 31 | yes |
| E | `timeout-slow3-n14-c2` | 0 | yes | 40 | yes |
| E | `timeout-slow5-over-client-deadline-n14-c2` | 0 | yes | 40 | yes |
| E | `timeout-slow3-n50-c3` | 0 | yes | 41 | yes |
| E | `cancel-disconnect20-n50-c3` | 0 | yes | 40 | yes |
| E | `cancel-allgone30-n50-c3` | 0 | yes | 23 | yes |
| E | `cancel-hidden-n14-c2` | 0 | yes | 23 | yes |
| C | `serve-before-n14-c2` | 0 | yes | 45 | yes |
| C | `serve-after-n14-c2` | 0 | yes | 45 | yes |
| C | `serve-before-n14-c2-settled` | 0 | yes | 46 | yes |
| C | `serve-after-n14-c2-settled` | 0 | yes | 42 | yes |
| C | `serve-after-n14-c2-noci0` | 0 | yes | 50 | yes |
| C | `serve-after-n14-c2-unfocused` | 0 | yes | 50 | yes |
| C | `serve-before-ghes-n14-c2` | 0 | yes | 52 | yes |
| C | `serve-after-ghes-n14-c2` | 0 | yes | 51 | yes |
| C | `serve-before-n10-c3` | 0 | yes | 50 | yes |
| C | `serve-after-n10-c3` | 0 | yes | 49 | yes |
| C | `serve-before-n50-c3` | 0 | yes | 51 | yes |
| C | `serve-after-n50-c3` | 0 | yes | 48 | yes |
| C | `serve-after-n50-c3-j0` | 0 | yes | 51 | yes |
| C | `serve-after-n50-c3-disjoint` | 0 | yes | 51 | yes |
| C | `serve-before-n200-c1` | 0 | yes | 56 | yes |
| C | `serve-after-n200-c1` | 0 | yes | 52 | yes |
| C | `serve-oldclient-n14-c2` | 0 | yes | 19 | yes |
| A | `ghes-desk-before-n10-focused` | 0 | yes | 43 | yes |
| A | `ghes-desk-after-n10-focused` | 0 | yes | 44 | yes |
| A | `ghes-desk-before-n10-unfocused` | 0 | yes | 43 | yes |
| A | `ghes-desk-after-n10-unfocused` | 0 | yes | 42 | yes |
| A | `ghes-desk-after-n10-unfocused-noidle` | 0 | yes | 44 | yes |
| A | `ghes-desk-before-n10-hidden` | 0 | yes | 44 | yes |
| A | `ghes-desk-after-n10-hidden` | 0 | yes | 45 | yes |
| A | `ghes-desk-after-n10-return` | 0 | yes | 46 | yes |
| A | `ghes-desk-before-n10-mixed` | 0 | yes | 45 | yes |
| A | `ghes-desk-after-n10-mixed` | 0 | yes | 44 | yes |
| A | `ghes-desk-after-n10-focused-noci0` | 0 | yes | 43 | yes |
| A | `ghes-desk-before-n50-focused` | 0 | yes | 44 | yes |
| A | `ghes-desk-after-n50-focused` | 0 | yes | 50 | yes |
| A | `ghes-desk-after-n50-focused-j0` | 0 | yes | 49 | yes |
| A | `ghes-desk-after-n50-focused-j25` | 0 | yes | 50 | yes |
| A | `ghes-desk-before-n50-unfocused` | 0 | yes | 50 | yes |
| A | `ghes-desk-after-n50-unfocused` | 0 | yes | 45 | yes |
| A | `ghes-desk-after-n50-return` | 0 | yes | 46 | yes |
| A | `ghes-desk-before-n50-mixed` | 0 | yes | 46 | yes |
| A | `ghes-desk-after-n50-mixed` | 0 | yes | 45 | yes |
| B | `dotcom-desk-before-n10` | 0 | yes | 46 | yes |
| B | `dotcom-desk-after-n10` | 0 | yes | 45 | yes |
| B | `dotcom-desk-before-n50` | 0 | yes | 45 | yes |
| B | `dotcom-desk-after-n50` | 0 | yes | 45 | yes |
| F | `detect-desk-before-n10` | 0 | yes | 47 | yes |
| F | `detect-desk-after-n10` | 0 | yes | 40 | yes |
| F | `detect-desk-after-n10-j0` | 0 | yes | 39 | yes |
| F | `detect-serve-before-n14-c2` | 0 | yes | 46 | yes |
| F | `detect-serve-after-n14-c2` | 0 | yes | 40 | yes |
| F | `detect-serve-after-n14-c2-seed2` | 0 | yes | 42 | yes |
| F | `detect-serve-after-n14-c2-j0` | 0 | yes | 41 | yes |
| F | `detect-serve-oldclient-n14-c2` | 0 | yes | 43 | yes |

Scenarios in specs3.txt: 66. Run: 66. Counted (rc=0 and JSON): 66.

## Group D: lanes (11)

Limit for visible `waitedS.max` = 300 x ceil((R+5)/15), R = `EXP_N` rows.

### gate-d3 (after): pass rules

| Scenario | R | neverServed (=0) | visible pk5min (<=15) | selected pk5min (<=10) | budgeted pk5min (<=20) | budgeted pk60 (<=11) | visible waitedS.max (limit) | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lanes-4sel-n50-c4-gate-d3` | 50 | 0 | 15 | 10 | 20 | 10 | 900 (1200) | PASS |
| `lanes-4sel-checks-n50-c4-gate-d3` | 50 | 0 | 15 | 10 | 20 | 11 | 910 (1200) | PASS |
| `lanes-2sel-n50-c2-gate-d3` | 50 | 0 | 15 | 10 | 20 | 8 | 920 (1200) | PASS |
| `lanes-1sel-checks-n14-c2-gate-d3` | 14 | 0 | 15 | 10 | 20 | 8 | 171 (600) | PASS |
| `lanes-1sel-checks-n50-c2-gate-d3` | 50 | 0 | 15 | 10 | 20 | 8 | 942 (1200) | PASS |
| `lanes-2sel-checks-n14-c2-gate-d3` | 14 | 0 | 15 | 10 | 20 | 10 | 215 (600) | PASS |
| `lanes-4sel-checks-n20-c4-gate-d3` | 20 | 0 | 15 | 10 | 20 | 11 | 347 (600) | PASS |
| `lanes-fg-n50-c4-gate-d3` | 50 | 0 | 15 | 10 | 20 | 11 | 900 (1200) | PASS |

Unbudgeted context for `lanes-fg-n50-c4-gate-d3` (REPORT-ONLY, not in the pass rule): interactive lane starts=2685, pk60=24, pk5min=114; all upstream starts max5min=134, max60s=35; interactiveOverflow=894.

### gate-d2 (before)

| Scenario | visible seen | neverServed | visible starts | visible waitedS.max | worst first-seen-to-first-start s | selected pk5min | budgeted pk5min / pk60 | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `lanes-4sel-n50-c4-gate-d2` | 50 | 29 | 17 | 781 | 10800 | 20 | 20 / 10 | REPORT-ONLY (expected "before": visible rows unserved: observed) |
| `lanes-4sel-checks-n50-c4-gate-d2` | 50 | 34 | 12 | 690 | 10800 | 20 | 20 / 14 | REPORT-ONLY (expected "before": visible rows unserved: observed) |
| `lanes-2sel-n50-c2-gate-d2` | 49 | 0 | 212 | 2020 | 1810 | 10 | 20 / 8 | REPORT-ONLY |

### Every selected identity (REPORT-ONLY, as is)

| Scenario | Identity | starts | medianGapS | maxGapS |
| --- | --- | --- | --- | --- |
| `lanes-4sel-n50-c4-gate-d2` | `pr:feat/wt-2` | 175 | 61 | 188 |
| `lanes-4sel-n50-c4-gate-d2` | `pr:feat/wt-7` | 175 | 61 | 154 |
| `lanes-4sel-n50-c4-gate-d2` | `pr:feat/wt-12` | 173 | 61 | 210 |
| `lanes-4sel-n50-c4-gate-d2` | `pr:feat/wt-17` | 174 | 61 | 165 |
| `lanes-4sel-n50-c4-gate-d3` | `pr:feat/wt-2` | 81 | 80 | 288 |
| `lanes-4sel-n50-c4-gate-d3` | `pr:feat/wt-7` | 73 | 157 | 289 |
| `lanes-4sel-n50-c4-gate-d3` | `pr:feat/wt-12` | 68 | 189 | 280 |
| `lanes-4sel-n50-c4-gate-d3` | `pr:feat/wt-17` | 71 | 157 | 295 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `pr:feat/wt-2` | 72 | 71 | 269 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `checks:feat/wt-2` | 107 | 60 | 240 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `pr:feat/wt-7` | 72 | 81 | 249 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `checks:feat/wt-7` | 106 | 60 | 230 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `pr:feat/wt-12` | 71 | 219 | 280 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `checks:feat/wt-12` | 106 | 60 | 250 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `pr:feat/wt-17` | 71 | 209 | 250 |
| `lanes-4sel-checks-n50-c4-gate-d2` | `checks:feat/wt-17` | 106 | 60 | 240 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `pr:feat/wt-2` | 36 | 310 | 580 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `checks:feat/wt-2` | 37 | 300 | 575 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `pr:feat/wt-7` | 36 | 300 | 585 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `checks:feat/wt-7` | 37 | 290 | 580 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `pr:feat/wt-12` | 39 | 290 | 580 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `checks:feat/wt-12` | 37 | 300 | 570 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `pr:feat/wt-17` | 37 | 300 | 580 |
| `lanes-4sel-checks-n50-c4-gate-d3` | `checks:feat/wt-17` | 34 | 300 | 580 |
| `lanes-2sel-n50-c2-gate-d2` | `pr:feat/wt-2` | 177 | 61 | 117 |
| `lanes-2sel-n50-c2-gate-d2` | `pr:feat/wt-7` | 177 | 61 | 93 |
| `lanes-2sel-n50-c2-gate-d3` | `pr:feat/wt-2` | 143 | 61 | 215 |
| `lanes-2sel-n50-c2-gate-d3` | `pr:feat/wt-7` | 144 | 61 | 223 |
| `lanes-1sel-checks-n14-c2-gate-d3` | `pr:feat/wt-2` | 170 | 60 | 239 |
| `lanes-1sel-checks-n14-c2-gate-d3` | `checks:feat/wt-2` | 171 | 60 | 189 |
| `lanes-1sel-checks-n50-c2-gate-d3` | `pr:feat/wt-2` | 141 | 60 | 239 |
| `lanes-1sel-checks-n50-c2-gate-d3` | `checks:feat/wt-2` | 146 | 60 | 230 |
| `lanes-2sel-checks-n14-c2-gate-d3` | `pr:feat/wt-2` | 99 | 80 | 240 |
| `lanes-2sel-checks-n14-c2-gate-d3` | `checks:feat/wt-2` | 87 | 81 | 270 |
| `lanes-2sel-checks-n14-c2-gate-d3` | `pr:feat/wt-7` | 92 | 80 | 275 |
| `lanes-2sel-checks-n14-c2-gate-d3` | `checks:feat/wt-7` | 83 | 80 | 290 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `pr:feat/wt-2` | 59 | 227 | 459 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `checks:feat/wt-2` | 41 | 300 | 480 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `pr:feat/wt-7` | 50 | 280 | 499 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `checks:feat/wt-7` | 41 | 290 | 325 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `pr:feat/wt-12` | 47 | 290 | 310 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `checks:feat/wt-12` | 42 | 290 | 310 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `pr:feat/wt-17` | 50 | 269 | 319 |
| `lanes-4sel-checks-n20-c4-gate-d3` | `checks:feat/wt-17` | 45 | 290 | 500 |
| `lanes-fg-n50-c4-gate-d3` | `pr:feat/wt-2` | 711 | 8 | 16 |
| `lanes-fg-n50-c4-gate-d3` | `pr:feat/wt-7` | 726 | 8 | 16 |
| `lanes-fg-n50-c4-gate-d3` | `pr:feat/wt-12` | 703 | 8 | 16 |
| `lanes-fg-n50-c4-gate-d3` | `pr:feat/wt-17` | 724 | 8 | 16 |

### Lane detail (REPORT-ONLY)

| Scenario | own starts / waitedS p50,p90,max | borrowed starts / waitedS p50,p90,max | visible starts / waitedS p50,p90,max | refusals sel / vis | clientFailures | over10s |
| --- | --- | --- | --- | --- | --- | --- |
| `lanes-4sel-n50-c4-gate-d2` | 697 / 0,0,89 | 0 / None,None,None | 17 / 80,710,781 | 19 / 8808 | 0 | 0 |
| `lanes-4sel-n50-c4-gate-d3` | 181 / 115,220,234 | 112 / 10,157,200 | 258 / 218,690,900 | 335 / 1830 | 0 | 0 |
| `lanes-4sel-checks-n50-c4-gate-d2` | 711 / 0,0,160 | 0 / None,None,None | 12 / 60,390,690 | 863 / 7767 | 0 | 0 |
| `lanes-4sel-checks-n50-c4-gate-d3` | 180 / 260,510,524 | 110 / 0,250,510 | 259 / 252,700,910 | 404 / 1949 | 0 | 0 |
| `lanes-2sel-n50-c2-gate-d2` | 354 / 0,0,25 | 0 / None,None,None | 212 / 928,1766,2020 | 2 / 3239 | 0 | 0 |
| `lanes-2sel-n50-c2-gate-d3` | 178 / 0,132,162 | 109 / 0,10,127 | 269 / 259,730,920 | 76 / 969 | 0 | 0 |
| `lanes-1sel-checks-n14-c2-gate-d3` | 178 / 0,0,178 | 163 / 0,10,28 | 102 / 0,90,171 | 56 / 132 | 0 | 0 |
| `lanes-1sel-checks-n50-c2-gate-d3` | 180 / 0,129,178 | 107 / 0,0,20 | 276 / 300,730,942 | 120 / 911 | 0 | 0 |
| `lanes-2sel-checks-n14-c2-gate-d3` | 180 / 77,179,230 | 168 / 10,128,169 | 93 / 11,99,215 | 334 / 147 | 0 | 0 |
| `lanes-4sel-checks-n20-c4-gate-d3` | 180 / 230,250,439 | 156 / 139,239,259 | 128 / 60,231,347 | 492 / 462 | 0 | 0 |
| `lanes-fg-n50-c4-gate-d3` | 120 / 0,0,50 | 59 / 0,0,0 | 221 / 320,700,900 | 719 / 1606 | 0 | 0 |

## Group E: timeouts, cancellation (6)

| Scenario | Criterion | Actual | Result |
| --- | --- | --- | --- |
| `timeout-slow3-n14-c2` | rpcSimulatedMs.over10s = 0 | 0 (p50 400 ms, p99 10000 ms, max 10000 ms) | PASS |
| `timeout-slow3-n14-c2` | clientFailures = 0 | 0 of 422 calls | PASS |
| `timeout-slow3-n14-c2` | replyDeadlineHits > 0 (slow run) | 70 | PASS |
| `timeout-slow5-over-client-deadline-n14-c2` | rpcSimulatedMs.over10s = 0 | 0 (p50 400 ms, p99 10000 ms, max 10000 ms) | PASS |
| `timeout-slow5-over-client-deadline-n14-c2` | clientFailures = 0 | 0 of 411 calls | PASS |
| `timeout-slow5-over-client-deadline-n14-c2` | replyDeadlineHits > 0 (slow run) | 78 | PASS |
| `timeout-slow3-n50-c3` | rpcSimulatedMs.over10s = 0 | 0 (p50 0 ms, p99 10000 ms, max 10000 ms) | PASS |
| `timeout-slow3-n50-c3` | clientFailures = 0 | 0 of 2328 calls | PASS |
| `timeout-slow3-n50-c3` | replyDeadlineHits > 0 (slow run) | 223 | PASS |
| `cancel-disconnect20-n50-c3` | rpcSimulatedMs.over10s = 0 | 0 (p50 0 ms, p99 2000 ms, max 3228 ms) | PASS |
| `cancel-disconnect20-n50-c3` | clientFailures = 0 | 0 of 1093 calls | PASS |
| `cancel-disconnect20-n50-c3` | replyDeadlineHits (not a slow run) | 0 | REPORT-ONLY |
| `cancel-disconnect20-n50-c3` | after the disconnect the remaining clients' queue ages return to the no-disconnect level within one window | **Not decidable from the harness output**: the JSON has only whole-run per-client aggregates, no queue age over time. Whole run (2 h), disconnect run: {'1': {'admits': 44, 'p50': 640, 'max': 930}, '2': {'admits': 196, 'p50': 390, 'max': 1005}, '3': {'admits': 33, 'p50': 72, 'max': 920}}. No-disconnect reference `serve-after-n50-c3-disjoint` (4 h): {'1': {'admits': 305, 'p50': 26, 'max': 1005}, '2': {'admits': 17, 'p50': 360, 'max': 440}, '3': {'admits': 45, 'p50': 10, 'max': 920}}. Visible waitedS p50/p90/max: disconnect [435, 800, 1005], reference [80, 760, 1005]. gh spawns hour 1 / hour 2: disconnect [219, 96], reference [219, 96] | NOT MEASURED (no PASS claimed) |
| `cancel-allgone30-n50-c3` | rpcSimulatedMs.over10s = 0 | 0 (p50 0 ms, p99 1000 ms, max 1800 ms) | PASS |
| `cancel-allgone30-n50-c3` | clientFailures = 0 | 0 of 1120 calls | PASS |
| `cancel-allgone30-n50-c3` | replyDeadlineHits (not a slow run) | 0 | REPORT-ONLY |
| `cancel-allgone30-n50-c3` | afterAllGone = 0 | 0; gh spawns per hour [110, 0]; spawns in minutes 31+ = 0 | PASS |
| `cancel-hidden-n14-c2` | rpcSimulatedMs.over10s = 0 | 0 (p50 400 ms, p99 1800 ms, max 1800 ms) | PASS |
| `cancel-hidden-n14-c2` | clientFailures = 0 | 0 of 6 calls | PASS |
| `cancel-hidden-n14-c2` | replyDeadlineHits (not a slow run) | 0 | REPORT-ONLY |
| `cancel-hidden-n14-c2` | 0 upstream starts after the first exposure | upstreamStarts=3 total; gh spawns per minute: minute 0 = 5, minutes 1-59 = 0 (resolution: 1 simulated minute; the JSON has no per-start timestamps) | PASS |

## Group C: serve cost (17)

| Scenario | sim h | spawns per hour | warm (last) hour | clientFailures (=0) | over10s | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `serve-before-n14-c2` | 4 | [729, 597, 399, 380] | 380 | 0 of 2672 | 0 | PASS |
| `serve-after-n14-c2` | 4 | [107, 23, 17, 16] | 16 | 0 of 405 | 0 | PASS |
| `serve-before-n14-c2-settled` | 4 | [731, 670, 418, 377] | 377 | 0 of 2672 | 0 | PASS |
| `serve-after-n14-c2-settled` | 4 | [68, 21, 19, 18] | 18 | 0 of 307 | 0 | PASS |
| `serve-after-n14-c2-noci0` | 4 | [108, 21, 16, 18] | 18 | 0 of 409 | 0 | PASS |
| `serve-after-n14-c2-unfocused` | 4 | [32, 4, 4, 4] | 4 | 0 of 118 | 0 | PASS |
| `serve-before-ghes-n14-c2` | 4 | [1652, 1140, 1110, 1127] | 1127 | 0 of 2650 | 0 | PASS |
| `serve-after-ghes-n14-c2` | 4 | [322, 61, 57, 49] | 49 | 0 of 391 | 0 | PASS |
| `serve-before-n10-c3` | 4 | [839, 820, 652, 607] | 607 | 0 of 2920 | 0 | PASS |
| `serve-after-n10-c3` | 4 | [85, 15, 13, 12] | 12 | 0 of 398 | 0 | PASS |
| `serve-before-n50-c3` | 2 | [3793, 3761] | 3761 | 0 of 6628 | 0 | PASS |
| `serve-after-n50-c3` | 4 | [211, 76, 50, 52] | 52 | 0 of 2383 | 0 | PASS |
| `serve-after-n50-c3-j0` | 4 | [209, 72, 50, 50] | 50 | 0 of 2300 | 0 | PASS |
| `serve-after-n50-c3-disjoint` | 4 | [219, 96, 56, 57] | 57 | 0 of 1784 | 0 | PASS |
| `serve-before-n200-c1` | 2 | [4958, 4918] | 4918 | 0 of 8659 | 0 | PASS |
| `serve-after-n200-c1` | 4 | [212, 211, 217, 217] | 217 | 0 of 4028 | 0 | PASS |
| `serve-oldclient-n14-c2` | 2 | [379, 375] | 375 | 0 of 1340 | 0 | PASS |

`serve-oldclient-n14-c2`: clientFailures=0 (PASS); gate untouched: admits={}, lane starts total=0, refusals={'selected': 0, 'visible': 0}, legacy={'hits': 301, 'upstreamReads': 670} (PASS).

### Warm-hour spawns and per-lane table (REPORT-ONLY; lane counters are whole-run)

| Scenario | warm-hour spawns | warm-hour by kind | req lower bound | pk60 warm | upstream starts | own | borrowed | visible | interactive | cache hits | lastGood over budget | deferredCold | max5min / max60s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `serve-before-n14-c2` | 380 | {'rest:pulls-by-head': 37, 'graphql:sidebar': 328, 'graphql:merge-metadata': 15} | 380 | 14 | 2672 | - | - | - | - | 0 | 0 | 0 | 72 / 28 |
| `serve-after-n14-c2` | 16 | {'graphql:sidebar': 11, 'graphql:merge-metadata': 3, 'rest:pulls-by-head': 2} | 16 | 4 | 138 | 13 | 0 | 125 | 0 | 32 | 66 | 37 | 18 / 8 |
| `serve-before-n14-c2-settled` | 377 | {'rest:pulls-by-head': 37, 'graphql:sidebar': 328, 'graphql:merge-metadata': 12} | 377 | 14 | 2672 | - | - | - | - | 0 | 0 | 0 | 72 / 28 |
| `serve-after-n14-c2-settled` | 18 | {'graphql:sidebar': 12, 'graphql:merge-metadata': 4, 'rest:pulls-by-head': 2} | 18 | 5 | 103 | 13 | 0 | 90 | 0 | 6 | 64 | 37 | 18 / 8 |
| `serve-after-n14-c2-noci0` | 18 | {'graphql:sidebar': 12, 'graphql:merge-metadata': 4, 'rest:pulls-by-head': 2} | 18 | 4 | 139 | 13 | 0 | 126 | 0 | 30 | 70 | 37 | 18 / 8 |
| `serve-after-n14-c2-unfocused` | 4 | {'graphql:sidebar': 2, 'graphql:merge-metadata': 2} | 4 | 2 | 31 | 13 | 0 | 18 | 0 | 8 | 20 | 37 | 18 / 8 |
| `serve-before-ghes-n14-c2` | 1127 | {'pr:view': 358, 'rest:pulls-by-head': 68, 'graphql:checks': 358, 'rest:pull': 298, 'auth:status': 35, 'graphql:merge-metadata': 10} | 1197 | 45 | 2650 | - | - | - | - | 0 | 0 | 0 | 72 / 28 |
| `serve-after-ghes-n14-c2` | 49 | {'auth:status': 12, 'pr:view': 11, 'graphql:checks': 11, 'graphql:merge-metadata': 3, 'rest:pull': 10, 'rest:pulls-by-head': 2} | 73 | 9 | 137 | 13 | 0 | 124 | 0 | 34 | 52 | 37 | 18 / 8 |
| `serve-before-n10-c3` | 607 | {'graphql:sidebar': 522, 'rest:pulls-by-head': 71, 'graphql:merge-metadata': 14} | 607 | 18 | 2920 | - | - | - | - | 0 | 0 | 0 | 78 / 30 |
| `serve-after-n10-c3` | 12 | {'graphql:sidebar': 8, 'graphql:merge-metadata': 2, 'rest:pulls-by-head': 2} | 12 | 3 | 101 | 13 | 0 | 88 | 0 | 39 | 51 | 17 | 18 / 8 |
| `serve-before-n50-c3` | 3761 | {'rest:pulls-by-head': 510, 'graphql:sidebar': 3239, 'graphql:merge-metadata': 12} | 3761 | 124 | 6628 | - | - | - | - | 0 | 0 | 0 | 363 / 148 |
| `serve-after-n50-c3` | 52 | {'rest:pulls-by-head': 11, 'graphql:sidebar': 36, 'graphql:merge-metadata': 5} | 52 | 7 | 328 | 13 | 0 | 315 | 0 | 123 | 966 | 323 | 18 / 8 |
| `serve-after-n50-c3-j0` | 50 | {'rest:pulls-by-head': 10, 'graphql:sidebar': 36, 'graphql:merge-metadata': 4} | 50 | 8 | 322 | 12 | 0 | 310 | 0 | 122 | 901 | 323 | 18 / 7 |
| `serve-after-n50-c3-disjoint` | 57 | {'rest:pulls-by-head': 10, 'graphql:sidebar': 42, 'graphql:merge-metadata': 5} | 57 | 6 | 367 | 26 | 0 | 341 | 0 | 77 | 784 | 240 | 20 / 9 |
| `serve-before-n200-c1` | 4918 | {'rest:pulls-by-head': 680, 'graphql:sidebar': 4229, 'graphql:merge-metadata': 9} | 4918 | 176 | 8659 | - | - | - | - | 0 | 0 | 0 | 482 / 200 |
| `serve-after-n200-c1` | 217 | {'graphql:sidebar': 169, 'rest:pulls-by-head': 42, 'graphql:merge-metadata': 6} | 217 | 10 | 734 | 13 | 0 | 721 | 0 | 49 | 2403 | 842 | 18 / 8 |
| `serve-oldclient-n14-c2` | 375 | {'rest:pulls-by-head': 34, 'graphql:sidebar': 329, 'graphql:merge-metadata': 12} | 375 | 14 | 670 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 36 / 14 |

### Before -> after pairs, warm hour (REPORT-ONLY)

| Pair | before | after | change |
| --- | --- | --- | --- |
| `serve-before-n14-c2` -> `serve-after-n14-c2` | 380 (hour 4) | 16 (hour 4) | -95.8% |
| `serve-before-n14-c2-settled` -> `serve-after-n14-c2-settled` | 377 (hour 4) | 18 (hour 4) | -95.2% |
| `serve-before-ghes-n14-c2` -> `serve-after-ghes-n14-c2` | 1127 (hour 4) | 49 (hour 4) | -95.7% |
| `serve-before-n10-c3` -> `serve-after-n10-c3` | 607 (hour 4) | 12 (hour 4) | -98.0% |
| `serve-before-n50-c3` -> `serve-after-n50-c3` | 3761 (hour 2) | 52 (hour 4) | -98.6% |
| `serve-before-n200-c1` -> `serve-after-n200-c1` | 4918 (hour 2) | 217 (hour 4) | -95.6% |

## Group A: desktop, GHES (20)

| Scenario | sim h | hour 1 | hour 4 (last hour if shorter) | all hours | auth spawns last hour | rate_limit probes last hour | req lower bound last hour | pk60 last hour | pk60 whole run | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ghes-desk-before-n10-focused` | 4 | 731 | 723 | [731, 717, 717, 723] | 32 | 0 | 787 | 19 | 25 | REPORT-ONLY |
| `ghes-desk-after-n10-focused` | 4 | 156 | 42 | [156, 44, 36, 42] | 10 | 0 | 62 | 8 | 25 | REPORT-ONLY |
| `ghes-desk-before-n10-unfocused` | 4 | 731 | 726 | [731, 717, 717, 726] | 32 | 0 | 790 | 17 | 25 | REPORT-ONLY |
| `ghes-desk-after-n10-unfocused` | 4 | 76 | 10 | [76, 15, 10, 10] | 2 | 0 | 14 | 5 | 25 | REPORT-ONLY |
| `ghes-desk-after-n10-unfocused-noidle` | 4 | 156 | 36 | [156, 44, 40, 36] | 9 | 0 | 54 | 8 | 25 | REPORT-ONLY |
| `ghes-desk-before-n10-hidden` | 2 | 0 | 0 (hour 2) | [0, 0] | 0 | 0 | 0 | 0 | 0 | PASS (hidden = 0: total spawns 0) |
| `ghes-desk-after-n10-hidden` | 2 | 0 | 0 (hour 2) | [0, 0] | 0 | 0 | 0 | 0 | 0 | PASS (hidden = 0: total spawns 0) |
| `ghes-desk-after-n10-return` | 2 | 147 | 40 (hour 2) | [147, 40] | 10 | 0 | 60 | 13 | 25 | REPORT-ONLY |
| `ghes-desk-before-n10-mixed` | 4 | 728 | 723 | [728, 723, 714, 723] | 32 | 0 | 787 | 18 | 25 | REPORT-ONLY |
| `ghes-desk-after-n10-mixed` | 4 | 256 | 37 | [256, 43, 37, 37] | 9 | 0 | 55 | 8 | 25 | REPORT-ONLY |
| `ghes-desk-after-n10-focused-noci0` | 4 | 156 | 41 | [156, 44, 36, 41] | 10 | 0 | 61 | 9 | 25 | REPORT-ONLY |
| `ghes-desk-before-n50-focused` | 4 | 831 | 818 | [831, 834, 833, 818] | 120 | 0 | 1058 | 25 | 25 | REPORT-ONLY |
| `ghes-desk-after-n50-focused` | 4 | 710 | 157 | [710, 157, 157, 157] | 41 | 0 | 239 | 24 | 25 | REPORT-ONLY |
| `ghes-desk-after-n50-focused-j0` | 4 | 708 | 156 | [708, 156, 156, 156] | 41 | 0 | 238 | 25 | 25 | REPORT-ONLY |
| `ghes-desk-after-n50-focused-j25` | 4 | 710 | 191 | [710, 161, 202, 191] | 49 | 0 | 289 | 16 | 25 | REPORT-ONLY |
| `ghes-desk-before-n50-unfocused` | 4 | 831 | 818 | [831, 834, 833, 818] | 120 | 0 | 1058 | 25 | 25 | REPORT-ONLY |
| `ghes-desk-after-n50-unfocused` | 4 | 211 | 15 | [211, 10, 10, 15] | 3 | 0 | 21 | 5 | 25 | REPORT-ONLY |
| `ghes-desk-after-n50-return` | 2 | 599 | 292 (hour 2) | [599, 292] | 73 | 0 | 438 | 24 | 25 | REPORT-ONLY |
| `ghes-desk-before-n50-mixed` | 4 | 831 | 818 | [831, 834, 833, 818] | 120 | 0 | 1058 | 25 | 25 | REPORT-ONLY |
| `ghes-desk-after-n50-mixed` | 4 | 811 | 158 | [811, 190, 158, 158] | 41 | 0 | 240 | 16 | 25 | REPORT-ONLY |

Return catch-up (REPORT-ONLY):

| Scenario | spawns before return (first 30 min) | spawns first 15 min after | catch-up burst s |
| --- | --- | --- | --- |
| `ghes-desk-after-n10-return` | 71 | 49 | 75 |
| `ghes-desk-after-n50-return` | 206 | 210 | 200 |

## Group B: desktop, github.com (4)

| Scenario | sim h | hour 1 | hour 4 (last hour if shorter) | all hours | auth spawns last hour | rate_limit probes last hour | req lower bound last hour | pk60 last hour | pk60 whole run | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dotcom-desk-before-n10` | 4 | 362 | 363 | [362, 362, 362, 363] | 0 | 91 | 363 | 9 | 10 | REPORT-ONLY |
| `dotcom-desk-after-n10` | 4 | 58 | 14 | [58, 14, 13, 14] | 0 | 1 | 14 | 3 | 9 | REPORT-ONLY |
| `dotcom-desk-before-n50` | 4 | 361 | 362 | [361, 362, 362, 362] | 0 | 84 | 362 | 10 | 10 | REPORT-ONLY |
| `dotcom-desk-after-n50` | 4 | 232 | 50 | [232, 49, 50, 50] | 0 | 1 | 50 | 8 | 9 | REPORT-ONLY |

## Group F: detection (8 x 24 simulated hours)

§15 rule is "report". Latencies are samples / p50 / p90 / max, seconds. Contract numbers: start selected 1,810 s, start visible 3,610 s, finish selected 70 s, finish visible 130 s plus slot wait. The harness does not output slot wait, so the "plus slot wait" part cannot be subtracted; max values are compared with the bare numbers.

| Scenario | events | undetected | startSelected | startVisible | finishSelected | finishVisible | spawns/h min..max (24 h mean) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `detect-desk-before-n10` | 97 | 0 | 16 / 41 / 60 / 62 | 33 / 43 / 107 / 115 | 16 / 36 / 55 / 57 | 32 / 68 / 114 / 126 | 711..729 (722.8) |
| `detect-desk-after-n10` | 97 | 14 | 16 / 725 / 1003 / 1182 | 18 / 484 / 1165 / 1341 | 16 / 47 / 60 / 62 | 32 / 118 / 1779 / 1945 | 49..174 (110.8) |
| `detect-desk-after-n10-j0` | 97 | 18 | 15 / 700 / 1191 / 1455 | 15 / 641 / 1375 / 1446 | 16 / 27 / 58 / 62 | 32 / 306 / 1847 / 2304 | 40..140 (97.0) |
| `detect-serve-before-n14-c2` | 97 | 0 | 32 / 31 / 45 / 56 | 66 / 52 / 110 / 120 | 32 / 34 / 56 / 59 | 64 / 62 / 107 / 119 | 367..719 (405.4) |
| `detect-serve-after-n14-c2` | 97 | 13 | 32 / 603 / 1036 / 1230 | 38 / 505 / 1244 / 1610 | 32 / 40 / 54 / 57 | 62 / 108 / 1699 / 1906 | 19..68 (43.6) |
| `detect-serve-after-n14-c2-seed2` | 93 | 17 | 26 / 870 / 1492 / 1619 | 34 / 456 / 860 / 1260 | 30 / 25 / 54 / 186 | 62 / 106 / 1480 / 1834 | 17..71 (36.6) |
| `detect-serve-after-n14-c2-j0` | 97 | 17 | 32 / 909 / 1316 / 1456 | 30 / 584 / 1446 / 1527 | 32 / 18 / 41 / 51 | 64 / 217 / 2085 / 2291 | 16..66 (37.9) |
| `detect-serve-oldclient-n14-c2` | 97 | 0 | 32 / 34 / 52 / 58 | 66 / 65 / 117 / 120 | 32 / 19 / 49 / 50 | 64 / 72 / 116 / 119 | 366..382 (375.3) |

### Max latency against the contract numbers

| Scenario | start selected max (<=1810) | start visible max (<=3610) | finish selected max (<=70) | finish visible max (<=130 + slot wait) | undetected |
| --- | --- | --- | --- | --- | --- |
| `detect-desk-before-n10` | 62 within | 115 within | 57 within | 126 within | 0 |
| `detect-desk-after-n10` | 1182 within | 1341 within | 62 within | **1945 OVER** (by 1815) | **14** |
| `detect-desk-after-n10-j0` | 1455 within | 1446 within | 62 within | **2304 OVER** (by 2174) | **18** |
| `detect-serve-before-n14-c2` | 56 within | 120 within | 59 within | 119 within | 0 |
| `detect-serve-after-n14-c2` | 1230 within | 1610 within | 57 within | **1906 OVER** (by 1776) | **13** |
| `detect-serve-after-n14-c2-seed2` | 1619 within | 1260 within | **186 OVER** (by 116) | **1834 OVER** (by 1704) | **17** |
| `detect-serve-after-n14-c2-j0` | 1456 within | 1527 within | 51 within | **2291 OVER** (by 2161) | **17** |
| `detect-serve-oldclient-n14-c2` | 58 within | 120 within | 50 within | 119 within | 0 |

## Unknown gh/git commands recorded by the harness

None in any of the 66 scenarios.

## Every FAIL / over-contract / unexpected item

- detect-desk-after-n10: undetected=14 of 97 events
- detect-desk-after-n10: finishVisible max 1945 s > bare contract 130 s (slot wait not reported by harness; p90 1779 s)
- detect-desk-after-n10-j0: undetected=18 of 97 events
- detect-desk-after-n10-j0: finishVisible max 2304 s > bare contract 130 s (slot wait not reported by harness; p90 1847 s)
- detect-serve-after-n14-c2: undetected=13 of 97 events
- detect-serve-after-n14-c2: finishVisible max 1906 s > bare contract 130 s (slot wait not reported by harness; p90 1699 s)
- detect-serve-after-n14-c2-seed2: undetected=17 of 93 events
- detect-serve-after-n14-c2-seed2: finishSelected max 186 s > contract 70 s
- detect-serve-after-n14-c2-seed2: finishVisible max 1834 s > bare contract 130 s (slot wait not reported by harness; p90 1480 s)
- detect-serve-after-n14-c2-j0: undetected=17 of 97 events
- detect-serve-after-n14-c2-j0: finishVisible max 2291 s > bare contract 130 s (slot wait not reported by harness; p90 2085 s)

## Comparison with the local figures

| Figure | Local (RUN.md / D3) | m4-air | Deviation |
| --- | --- | --- | --- |
| GHES desktop, 10 worktrees, focused, before, warm hour | 717 spawns/h | hours 1 to 4: 731, 717, 717, 723. Hour 4 = 723 | hour 4: +0.8%. Hours 2 and 3 equal the local figure |
| GHES desktop, 10 worktrees, focused, after, warm hour | 36 spawns/h | hours 1 to 4: 156, 44, 36, 42. Hour 4 = 42 | hour 4: **+16.7%** (6 spawns). Hour 3 equals the local figure |
| Serve 14 rows x 2 clients, before, warm hour | 377 | mixed: 380 (hours 729, 597, 399, 380). settled: 377 (731, 670, 418, 377) | mixed +0.8%; settled equal |
| Serve 14 rows x 2 clients, after, warm hour | 16 | mixed: 16 (107, 23, 17, 16). settled: 18 (68, 21, 19, 18) | mixed equal; settled **+12.5%** (2 spawns) |
| D3 lanes, worst visible wait | 471 to 491 s | gate-d3 visible `waitedS.max`: N=50: 900, 910, 920, 942, 900 (fg). N=20: 347. N=14: 171, 215 | **No m4-air scenario falls in 471 to 491 s.** N=50 values are 83% to 100% above that range; N=14/20 values are below it. All are inside the §15 limit (1,200 s at N=50, 600 s at N=14/20) |

The brief gives the local figures without the scenario names, so the pairing above (focused N=10 for GHES desktop, `serve-*-n14-c2` and `-settled` for serve, gate-d3 visible `waitedS.max` for lanes) is my reading. Other m4-air numbers near 471 to 491 s, for whoever knows which metric the local figure was: selected-identity `maxGapS` in `lanes-4sel-checks-n20-c4-gate-d3` is 459, 480, 499; selected-own `waitedS.max` is 439 there and 524 in `lanes-4sel-checks-n50-c4-gate-d3`.

## Reproducibility check (extra, not in RUN.md)

Because the lanes figures differ from the local ones, two scenarios were run a second time with the identical spec line (parallel 2, load about 4.5), writing to `determinism-check/`. Both rc=0. Neither JSON is identical to the main run.

| Scenario | Metric | Main run | Rerun |
| --- | --- | --- | --- |
| `lanes-4sel-n50-c4-gate-d3` (3 h) | total gh spawns | 604 | 603 |
| | visible waitedS.max / budgeted pk5min / pk60 / neverServed | 900 / 20 / 10 / 0 | 900 / 20 / 10 / 0 |
| | selected identities maxGapS | 288, 289, 280, 295 | 288, 288, 280, 295 |
| | last-hour rolling peak 60 s | 7 | 8 |
| `detect-serve-after-n14-c2` (24 h) | total gh spawns | 1,046 | 1,011 (-3.3%) |
| | undetected / events | 13 / 97 | 14 / 97 |
| | startSelected samples/p50/p90/max | 32 / 603 / 1036 / 1230 | 32 / 653 / 1166 / 1712 |
| | startVisible | 38 / 505 / 1244 / 1610 | 36 / 443 / 1278 / 1686 |
| | finishSelected | 32 / 40 / 54 / 57 | 32 / 31 / 48 / 50 |
| | finishVisible | 62 / 108 / 1699 / 1906 | 62 / 111 / 1734 / 2079 |

The pass/fail results above use the main run only. The rerun does not change any verdict, but single-run values, the 24 h detection maxima in particular, move between runs on the same machine and commit. The cause was not investigated (measurement only).

## Notes and limits

- "Selected" in the D pass rule was read as `selectedTotal.peak5min`; "R" as `EXP_N`.
- `cancel-hidden` was checked at 1-simulated-minute resolution (`gh.timelinePerMinute`): all 5 gh spawns (3 upstream starts) are in minute 0, none in minutes 1 to 59.
- "hidden = 0" was applied to total spawns of the two `hidden` scenarios (both 0).
- Lane counters in the C per-lane table are whole-run, not warm-hour; the harness does not split them by hour.
- Driver used for the full run (not part of the harness; calls `run-specs.sh` once per group in priority order and logs `uptime` before and after):

```sh
E=src/main/github/__experiments__
CORES=$(sysctl -n hw.ncpu)
for g in "D:^lanes-" "E:^(timeout|cancel)-" "C:^serve-" "A:^ghes-desk-" "B:^dotcom-" "F:^detect-"; do
  name=${g%%:*}; re=${g#*:}
  load=$(sysctl -n vm.loadavg | awk '{print $2}')
  par=4; if awk "BEGIN{exit !($load > $CORES)}"; then par=2; fi
  echo "group $name before $(date -u +%FT%TZ) par=$par $(uptime)" | tee -a $E/uptime-log.txt
  $E/run-specs.sh $E/specs3.txt $par "$re"
  echo "group $name after $(date -u +%FT%TZ) $(uptime)" | tee -a $E/uptime-log.txt
done
```

## Files

`results/*.json` (66 scenarios + 4 probes), `logs/*.log`, `logs-probes.txt`, `run-stdout-smoke.txt`, `sha256.txt`, `uptime-log.txt`, `determinism-check/`, and at the repository root `table3.txt` and `run-stdout.txt`. Model: Claude Fable 5.2 (claude-fable-5-2), effort low.
