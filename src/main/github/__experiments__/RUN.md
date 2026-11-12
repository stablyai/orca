# STA-8667 polling harness: how to run (D3r)

Design-evidence harness for the automatic PR/checks polling design, round D3r (the pre-review revision of D3
after the first m4-air run). **Never merge this branch.** No PR.
It was committed with git plumbing, so the repository's commit hooks and lint did not run on it.

- Branch: `AmethystLiang/sta-8667-polling-harness`, based on `9f32c6d06dd` (the design's source-reading commit).
- D3 is **automatic only**: no cadence setting exists in the harness. `specs2.txt` / `table2.py` are the D2 list and
  tabulator, kept for the record; they name `EXP_CADENCE`, which the harness now ignores. `specs3.txt` is the D3 list (66
  scenarios), also kept. **Run `specs3r.txt`** (the same 66 plus 28 added in D3r).

## What changed in D3r (harness)

1. **Deterministic.** The D3 harness advanced simulated time with `advanceTimersByTimeAsync(1000)`. Production code on
   the read path does real file I/O (`local-git-config-signature.ts`, through `fs.promises`), and the continuation of
   each such call landed in whichever simulated second the wall clock allowed. Now one fake timer fires at a time and
   all real I/O it caused is drained before simulated time moves. Two runs of one spec line give the same `gh` spawn
   at the same simulated millisecond; every JSON carries `determinism.spawnDigest` (sha256 over every `gh` spawn
   time and kind) and `gateDigest` (gate events including which client asked). Residual: when two clients ask for
   the same row in the same millisecond, which of them the start is attributed to can differ between runs (seen in
   1 of 8 local reruns, one start of 313). `verdict3r.py` judges host-level identity and reports that case.
2. **Detection is per event and per observer, with slot wait.** `detection.perEvent` lists every CI start / finish
   with the row's next due time at that moment, who saw it, how late, and how much of that was waiting for a slot.
   `detection.classes` puts every (event, observer) pair in one class with its bound (see "F" below).
3. **Queue-age time series.** `serve.queueAgeSeries`: per client and per 5-minute window, starts, refusals, and the
   age of each start since its first refusal (p50 / max), plus open claims at the end of each window.
4. **New knobs**: `EXP_RUN_MIN_MIN` / `EXP_RUN_MAX_MIN` (length of an external CI run, default 20 / 30 as in D3),
   `EXP_GAP_MIN_MIN` / `EXP_GAP_MAX_MIN` (quiet gap, default 50 / 80), `EXP_CAP_SELECTED_MIN` / `EXP_CAP_VISIBLE_MIN`
   (cap options of product decision PD-1, default 30 / 60 = the contract), `EXP_TRACE=1` (also writes every spawn to
   `<out>.trace.txt`).
5. `run-specs.sh` takes `OUT_SUBDIR=<name>` (writes `results/<name>/`, `logs/<name>/`). `verdict3r.py` computes
   every pass rule of design §15 and exits 1 on any FAIL.

## Files

| File | What it is |
| --- | --- |
| `polling-d2.experiment.test.ts` | The full harness (name kept from D2). vitest, fake timers, simulated time. Real code under test: PR refresh coordinator, queue, drainer, pacing, visibility, rate-limit gate, lookup pipeline, and the real renderer refresh scheduler. Replaced: the `gh` and `git` subprocess boundaries (canned answers, recorded). |
| `policy-d3.ts` | The D3 pacing policy: fixed caps (selected 30 min, visible 60 min), check-activity classes, stuck-check decay. |
| `gate-d3.ts` | The serve admission gate. `createGateD3` is the D3 lanes rule (design §4.4). `createGateD2` reproduces the frozen D2 gate and is the "before" for finding D2-2. |
| `scheduler-patches.ts` | Builds the `base`, `d2` and `d3` variants of the real scheduler by patching its source text; the client hint store. |
| `rate-limit-d3.ts` | Prototype (a model, not production code) of the per-resource rate-limit rule (design §4.5). |
| `*.probe.test.ts` | Four fast probes (seconds each): gate lanes, scheduler, policy, rate limit. |
| `specs3r.txt`, `run-specs.sh`, `table3.py`, `verdict3r.py` | Run list, runner, tabulator, pass rules. |
| `specs3r-local.txt`, `local-digests.txt` | The 45 small scenarios run on the authoring Mac and their digests. m4-air must reproduce the digests. |
| `polling-cost.experiment.test.ts` | D1 harness, reference only. Not part of any run list. |

## Setup

```sh
git fetch origin AmethystLiang/sta-8667-polling-harness
git checkout <the SHA you were given>      # record it with the results
pnpm install --frozen-lockfile
cd src/main/github/__experiments__ && shasum -a 256 *.ts specs3r.txt specs3r-local.txt local-digests.txt run-specs.sh table3.py verdict3r.py; cd -   # record with the results
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
src/main/github/__experiments__/run-specs.sh "$PWD/src/main/github/__experiments__/specs3r.txt" 3 \
  '^(serve-after-n14-c2|ghes-desk-after-n10-focused|cancel-hidden-n14-c2)$'
```

Give the spec file as an absolute path: the runner changes directory to the repository root.

### 3. Determinism gate (do this before the full list; 45 small scenarios, 28 of them twice)

```sh
E=src/main/github/__experiments__
OUT_SUBDIR=local  $E/run-specs.sh "$PWD/$E/specs3r-local.txt" 4
OUT_SUBDIR=local2 $E/run-specs.sh "$PWD/$E/specs3r-local.txt" 4 '^(local-detect-|lanes-|cancel-)'
python3 $E/verdict3r.py $E/results/local --rerun $E/results/local2 --digests $E/local-digests.txt | tee verdict-local.txt
```

Expected: every `G rerun identical (host level)` and every `G digest equals authoring Mac` line is PASS
(authoring Mac: 45 scenarios, 143 PASS, 0 FAIL, one `G per-client attribution differs` REPORT line). If a digest
differs from the authoring Mac's but the two m4-air runs agree with each other, the harness is deterministic per
machine but not across Node versions (authoring: node v26.10.0): report it and go on; the m4-air numbers then stand
on their own. If two m4-air runs of one line differ, stop and report.

### 4. Full list

```sh
E=src/main/github/__experiments__
CORES=$(sysctl -n hw.ncpu)
for g in "D:^lanes-" "E:^(timeout|cancel)-" "C:^serve-" "A:^ghes-desk-" "B:^dotcom-" "H:^capcost-" "F:^detect-"; do
  name=${g%%:*}; re=${g#*:}
  load=$(sysctl -n vm.loadavg | awk '{print $2}')
  par=4; if awk "BEGIN{exit !($load > $CORES)}"; then par=2; fi
  echo "group $name before $(date -u +%FT%TZ) par=$par $(uptime)" | tee -a $E/uptime-log.txt
  $E/run-specs.sh "$PWD/$E/specs3r.txt" $par "$re" 2>&1 | tee -a run-stdout.txt
  echo "group $name after $(date -u +%FT%TZ) $(uptime)" | tee -a $E/uptime-log.txt
done
```

`run-specs.sh <spec file> [parallel, default 4] [regex on scenario names, default all]`. It runs in batches of
`parallel`, prints `<name> rc=<exit> wall=<seconds>s` per scenario and `ALL DONE`. `PER_RUN_TIMEOUT_S`
(default 3000) kills a scenario that hangs. Outputs: `results/<name>.json` and `logs/<name>.log` next to the script
(git-ignored). A scenario counts only if `rc=0` **and** its JSON exists.

Priority order if time is short: **D, E, C, A, B, H, F**. Group F is 20 simulations of 24 hours. On the first m4-air
run the whole D3 list took 13 minutes of wall time; the D3r stepping does more real event-loop turns per simulated
second, so expect it to be slower (see "Expected durations").

### 5. Rerun three scenarios for the determinism rule at full size

```sh
OUT_SUBDIR=rerun $E/run-specs.sh "$PWD/$E/specs3r.txt" 3 \
  '^(lanes-4sel-n50-c4-gate-d3|detect-serve-after-n14-c2|ghes-desk-after-n50-focused)$'
```

One scenario by hand:

```sh
EXP_SCENARIO=serve-after EXP_GATE=d3 EXP_HOST=dotcom EXP_N=14 EXP_CLIENTS=2 EXP_WORKLOAD=mixed EXP_JITTER=0.1 EXP_HOURS=0.5 \
EXP_OUT=/tmp/smoke.json VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
npx vitest run --config config/vitest.config.ts src/main/github/__experiments__/polling-d2.experiment.test.ts
```

## Tabulate and judge

```sh
python3 $E/table3.py > table3.txt
python3 $E/verdict3r.py $E/results --rerun $E/results/rerun | tee verdict3r.txt    # exit code 1 if any FAIL
```

`verdict3r.py` prints one line per rule per scenario (`PASS` / `FAIL` / `REPORT`) and a summary. The rules are the
table in design §15; nothing has to be judged by hand any more.

Send back, untouched: `results/` (including `local/`, `local2/`, `rerun/` and `*.probe.json`), `logs/`,
`logs-probes.txt`, `table3.txt`, `verdict3r.txt`, `verdict-local.txt`, `run-stdout.txt`, `uptime-log.txt`, the commit
SHA and the sha256 lines from Setup.

## Expected durations

- m4-air, D3 harness (the previous stepping), parallel 4, load 4-7 on 10 cores: the 66 D3 scenarios took 768 s of
  wall time in total, 19-56 s each; vitest reported 2.6 s for a 4 h `serve-after` at 14 rows and 5.8 s for a 24 h
  detection run.
- Authoring Mac, D3r harness, parallel 2, load 13-52: 37-60 s of wall time per scenario (start-up dominated), one
  pair at 1,428 s while the machine stalled. vitest reported 3.6-6.8 s for 4 h scenarios at 10-14 rows, 3.9 s for
  1.5 h at 30 rows and 4 clients, and 25 s for an 8 h detection run.
- Not measured anywhere on the D3r harness: 50 and 200 rows, and 24 h. The D3r stepping does one real event-loop
  turn or more per fake timer (`determinism.realEventLoopTurns` in the JSON; 59,103 for the 8 h serve detection
  run), so the 24 h runs should take a few minutes each instead of seconds. Please keep the wall times the runner
  prints; they become the reference.

## What each scenario measures (`specs3r.txt`)

`before` is the code as checked out; `after` is the D3 proposal. `nN` rows; `cN` paired clients.

| Group | Scenarios | What they measure |
| --- | --- | --- |
| A | `ghes-desk-{before,after}-n{10,50}-…` | Desktop app against a GHES host: `gh` spawns per hour by kind. `focused`, `unfocused` (5-minute pause), `unfocused-noidle` (pause off), `hidden`, `return` (catch-up after 30 min away), `mixed` (1 in 5 linked rows running CI), `noci0` (the D2 world without no-CI rows), `j0`/`j25` (jitter 0 / 25%). |
| B | `dotcom-desk-*` | Same on github.com, where `gh api rate_limit` probes appear. |
| C | `serve-{before,after}-…`, `serve-oldclient-…` | Paired-client path: upstream starts, starts per 5 min and per 60 s, gate admits per lane, cache hits, last-good answers served over budget, cold deferrals, reply times, client failures. `oldclient` = a legacy client (no `selected` field) against the new host: not gated. |
| D | `lanes-…-gate-d2` / `-gate-d3` | Finding D2-2. 2 or 4 clients each select a different PR with running CI (`EXP_SELECTED_IDS`), with or without a Checks-panel read per client (`EXP_CHECKS`), against 14–50 visible rows. Same scenario on the D2 gate (before) and the D3 lanes gate (after). Read: per-lane starts and peaks, `visibleIdentities.neverServed`, visible `waitedS`, and `selected identity … maxGapS`. `lanes-fg-*` adds a foreground read every 8 s per client (interactive lane, 3 per 30 s, overflow into the selected lane). |
| E (added) | `cancel-ref-*` | The disconnect scenarios without the disconnect. `verdict3r.py` compares `queueAgeSeries` of each remaining client, window by window from one window after the disconnect, with the level of the reference run (+15 s claim grace). |
| E | `timeout-*`, `cancel-*` | `timeout-slow3`: every 3rd upstream PR read takes 25 s; `slow5-over-client-deadline`: every 5th takes 45 s (longer than the 30 s client deadline). Read `replyDeadlineHits`, `rpcSimulatedMs.over10s` (must be 0), `clientFailures`. `cancel-disconnect20`: client 1 vanishes at minute 20 without telling the host; `cancel-allgone30`: all clients vanish at minute 30, `afterAllGone` must be 0; `cancel-hidden`: hidden clients, zero timed reads. |
| F | `detect-*` | 24 simulated hours with external CI start/finish events on 3 PRs (one selected, two visible). Per (event, observer) pair, one class and one bound, judged on `latency - slot wait`: **finishSeenRunning** (the observer had seen the run running): 70 s selected / 130 s visible. **finishSeenStuck** (non-selected, seen running and unchanged for 30 min or more): the stuck-check ladder interval + 10 s. **startSeen**, **startTransient** (the run ended before the row's next read, so it was never shown as running) and **finishRunNeverSeen**: cap + 10 s. `uncovered` (no read at all after the event although the run went on longer than cap + 25 min) must be 0. `-seed2/3`: other event timings. `-longrun`: 40-50 minute runs. `-shortrun`: 5-10 minute runs. `-sel15/-sel10/-sel5/-vis30/-vis20`: the cap options of PD-1. |
| H | `capcost-*` | The same cap options in a quiet world (4 h), for the cost column of PD-1. Compare with `ghes-desk-after-n10-focused` / `-n50-focused`. |
| G | (rule, no scenarios of its own) | Determinism: `results/rerun/*.json` and `results/local2/*.json` must have the digests of their first runs; `results/local/*.json` should have the digests in `local-digests.txt`. |

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
