# STA-8667 polling harness: how to run (D3)

Design-evidence harness for the automatic PR/checks polling design, round D3. **Never merge this branch.** No PR.
It was committed with git plumbing, so the repository's commit hooks and lint did not run on it.

- Branch: `AmethystLiang/sta-8667-polling-harness`, based on `9f32c6d06dd` (the design's source-reading commit).
- D3 is **automatic only**: no cadence setting exists in the harness. `specs2.txt` / `table2.py` are the D2 list and
  tabulator, kept for the record; they name `EXP_CADENCE`, which the harness now ignores. **Run `specs3.txt`.**

## Files

| File | What it is |
| --- | --- |
| `polling-d2.experiment.test.ts` | The full harness (name kept from D2). vitest, fake timers, simulated time. Real code under test: PR refresh coordinator, queue, drainer, pacing, visibility, rate-limit gate, lookup pipeline, and the real renderer refresh scheduler. Replaced: the `gh` and `git` subprocess boundaries (canned answers, recorded). |
| `policy-d3.ts` | The D3 pacing policy: fixed caps (selected 30 min, visible 60 min), check-activity classes, stuck-check decay. |
| `gate-d3.ts` | The serve admission gate. `createGateD3` is the D3 lanes rule (design §4.4). `createGateD2` reproduces the frozen D2 gate and is the "before" for finding D2-2. |
| `scheduler-patches.ts` | Builds the `base`, `d2` and `d3` variants of the real scheduler by patching its source text; the client hint store. |
| `rate-limit-d3.ts` | Prototype (a model, not production code) of the per-resource rate-limit rule (design §4.5). |
| `*.probe.test.ts` | Four fast probes (seconds each): gate lanes, scheduler, policy, rate limit. |
| `specs3.txt`, `run-specs.sh`, `table3.py` | Run list, runner, tabulator. |
| `polling-cost.experiment.test.ts` | D1 harness, reference only. Not part of any run list. |

## Setup

```sh
git fetch origin AmethystLiang/sta-8667-polling-harness
git checkout <the SHA you were given>      # record it with the results
pnpm install --frozen-lockfile
cd src/main/github/__experiments__ && shasum -a 256 *.ts specs3.txt run-specs.sh table3.py; cd -   # record with the results
```

Node and vitest used when the harness was written: node v26.10.0, vitest 5.0.5.

## Run

Everything below is run from the repository root.

### 1. Fast probes (do these first; about 10 s of test time in total)

```sh
EXP_OUT_DIR=src/main/github/__experiments__/results VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
npx vitest run --config config/vitest.config.ts \
  src/main/github/__experiments__/gate-lanes.probe.test.ts \
  src/main/github/__experiments__/scheduler-d3.probe.test.ts \
  src/main/github/__experiments__/policy-d3.probe.test.ts \
  src/main/github/__experiments__/rate-limit-d3.probe.test.ts 2>&1 | tee src/main/github/__experiments__/logs-probes.txt
```

Expected: 4 files, 17 tests, all passing. They write `results/*.probe.json`. A failing assertion here means the
harness does not implement the D3 rule and the long runs should not start.

### 2. Smoke (three scenarios)

```sh
src/main/github/__experiments__/run-specs.sh src/main/github/__experiments__/specs3.txt 3 \
  '^(serve-after-n14-c2|ghes-desk-after-n10-focused|cancel-hidden-n14-c2)$'
```

### 3. Full list

```sh
uptime
src/main/github/__experiments__/run-specs.sh src/main/github/__experiments__/specs3.txt 4 2>&1 | tee run-stdout.txt
uptime
```

`run-specs.sh <spec file> [parallel, default 4] [regex on scenario names, default all]`. It runs in batches of
`parallel`, prints `<name> rc=<exit> wall=<seconds>s` per scenario and `ALL DONE`. `PER_RUN_TIMEOUT_S`
(default 3000) kills a scenario that hangs. Outputs: `results/<name>.json` and `logs/<name>.log` next to the script
(git-ignored). A scenario counts only if `rc=0` **and** its JSON exists.

If time is short, the groups in priority order are **D, E, C, A, B, F** (regex `'^lanes-'`, `'^(timeout|cancel)-'`,
`'^serve-'`, `'^ghes-desk-'`, `'^dotcom-'`, `'^detect-'`). Group F is eight 24-hour simulations and is the longest.

One scenario by hand:

```sh
EXP_SCENARIO=serve-after EXP_GATE=d3 EXP_HOST=dotcom EXP_N=14 EXP_CLIENTS=2 EXP_WORKLOAD=mixed EXP_JITTER=0.1 EXP_HOURS=0.5 \
EXP_OUT=/tmp/smoke.json VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
npx vitest run --config config/vitest.config.ts src/main/github/__experiments__/polling-d2.experiment.test.ts
```

## Tabulate

```sh
python3 src/main/github/__experiments__/table3.py > table3.txt
```

Send back, untouched: `results/*.json` (including `*.probe.json`), `logs/*.log`, `logs-probes.txt`, `table3.txt`,
`run-stdout.txt`, the commit SHA, the sha256 lines from Setup, and `uptime` before and after.

## Expected durations

Measured only on the authoring Mac, at load average 25–40, so treat them as upper bounds for an idle machine:

- Each fast probe file: under 1 s of test time; about 20–60 s wall including `npx` start-up.
- A scenario's wall time is dominated by start-up (about 2 minutes on the loaded Mac when 5–6 run in parallel;
  vitest itself reported 5.7 s for 0.5 simulated hours of `serve-after`, N=14, 2 clients).
- Not measured anywhere: the N=50 and N=200 scenarios at 3–4 simulated hours, and the 24 h detection sweeps. During
  D2 the shared Mac was at load 150–300 and those were killed at their limit. Cost grows with simulated hours × rows
  × clients. Please keep the per-scenario wall times the runner prints; they become the reference.

## What each scenario measures (`specs3.txt`)

`before` is the code as checked out; `after` is the D3 proposal. `nN` rows; `cN` paired clients.

| Group | Scenarios | What they measure |
| --- | --- | --- |
| A | `ghes-desk-{before,after}-n{10,50}-…` | Desktop app against a GHES host: `gh` spawns per hour by kind. `focused`, `unfocused` (5-minute pause), `unfocused-noidle` (pause off), `hidden`, `return` (catch-up after 30 min away), `mixed` (1 in 5 linked rows running CI), `noci0` (the D2 world without no-CI rows), `j0`/`j25` (jitter 0 / 25%). |
| B | `dotcom-desk-*` | Same on github.com, where `gh api rate_limit` probes appear. |
| C | `serve-{before,after}-…`, `serve-oldclient-…` | Paired-client path: upstream starts, starts per 5 min and per 60 s, gate admits per lane, cache hits, last-good answers served over budget, cold deferrals, reply times, client failures. `oldclient` = a legacy client (no `selected` field) against the new host: not gated. |
| D | `lanes-…-gate-d2` / `-gate-d3` | Finding D2-2. 2 or 4 clients each select a different PR with running CI (`EXP_SELECTED_IDS`), with or without a Checks-panel read per client (`EXP_CHECKS`), against 14–50 visible rows. Same scenario on the D2 gate (before) and the D3 lanes gate (after). Read: per-lane starts and peaks, `visibleIdentities.neverServed`, visible `waitedS`, and `selected identity … maxGapS`. `lanes-fg-*` adds a foreground read every 8 s per client (interactive lane, 3 per 30 s, overflow into the selected lane). |
| E | `timeout-*`, `cancel-*` | `timeout-slow3`: every 3rd upstream PR read takes 25 s; `slow5-over-client-deadline`: every 5th takes 45 s (longer than the 30 s client deadline). Read `replyDeadlineHits`, `rpcSimulatedMs.over10s` (must be 0), `clientFailures`. `cancel-disconnect20`: client 1 vanishes at minute 20 without telling the host; `cancel-allgone30`: all clients vanish at minute 30, `afterAllGone` must be 0; `cancel-hidden`: hidden clients, zero timed reads. |
| F | `detect-*` | 24 simulated hours with external CI start/finish events on 3 PRs: detection latency (samples/p50/p90/max seconds), undetected events. |

`table3.py` prints, per scenario: spawns per hour, last-hour PR reads, `auth:status` spawns, `rate_limit` probes, a
request lower bound that counts each `auth:status` spawn as 3 HTTP requests, rolling 60 s peaks, and for serve runs
the gate counters per lane.

## Known limits

- Counts are `gh` spawns. One spawn is one HTTP request except `gh auth status` (3 requests on the one two-login
  machine where it was measured, so 2 more than the spawn count; other account counts not measured).
- The Checks-panel read is modelled (one `graphql:checks` spawn, answer from the fixture); production
  `github.prChecks` is not exercised.
- `rate-limit-d3.ts` is a model of the proposed rule. The desktop "after" scenarios model header-fed state as
  "reuse the last probe until its reset", which only reproduces the probe count.
- Simulated host: no real GHES, no real paired transport, no upstream errors, one desktop window.
