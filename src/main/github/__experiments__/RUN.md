# STA-8667 polling harness: how to run

Design-evidence harness for the automatic PR/checks polling design. **Never merge this branch.** No PR.
It was committed with git plumbing, so the repository's commit hooks and lint did not run on it.

- Branch: `AmethystLiang/sta-8667-polling-harness`, based on `9f32c6d06dd` (the design's source-reading commit).
- Harness: `polling-d2.experiment.test.ts` (vitest, fake timers, simulated time).
  Real code under test: PR refresh coordinator, queue, drainer, pacing, visibility, rate-limit gate, lookup pipeline,
  and the real renderer refresh scheduler. Replaced: the `gh` and `git` subprocess boundaries (canned answers, recorded).
  The "after" scenarios prototype the proposal next to production code; no production file is changed.
- `polling-cost.experiment.test.ts` is the D1 harness, kept for reference. It is not part of any run list.

## Setup

```sh
git fetch origin AmethystLiang/sta-8667-polling-harness
git checkout <the SHA you were given>      # record it with the results
pnpm install --frozen-lockfile
shasum -a 256 src/main/github/__experiments__/polling-d2.experiment.test.ts \
              src/main/github/__experiments__/specs*.txt     # record with the results
```

Node and vitest versions used when the harness was written: node v26.10.0, vitest 5.0.5.

## Run

One scenario by hand (the env names are documented at the top of the harness file):

```sh
EXP_SCENARIO=serve-after EXP_HOST=dotcom EXP_N=14 EXP_CLIENTS=2 EXP_WORKLOAD=mixed EXP_JITTER=0.1 EXP_HOURS=0.5 \
EXP_OUT=/tmp/smoke.json VITE_CONFIG_NATIVE_IGNORE_WARNING=true \
npx vitest run --config config/vitest.config.ts src/main/github/__experiments__/polling-d2.experiment.test.ts
```

A whole spec file (one scenario per line, `<name> ENV=VALUE ...`):

```sh
src/main/github/__experiments__/run-specs.sh src/main/github/__experiments__/specs2.txt 4
# args: <spec file> [parallel, default 4] [regex on scenario names, default all]
# PER_RUN_TIMEOUT_S (default 3000) kills a scenario that hangs.
```

It prints `<name> rc=<exit> wall=<seconds>s` per scenario and `ALL DONE` at the end.
Outputs: `results/<name>.json` (raw result) and `logs/<name>.log`, both next to the script and git-ignored.
A scenario counts only if `rc=0` **and** its JSON exists. Keep the per-scenario wall times.

## Tabulate

```sh
python3 src/main/github/__experiments__/table2.py > table.txt
```

Send back, untouched: `results/*.json`, `logs/*.log`, `table.txt`, the runner's stdout, the commit SHA,
the two sha256 lines above, and `uptime` before and after.

## Expected durations

Only one timing exists, so treat everything else as unknown:

- Measured on the authoring Mac (load average about 25): `serve-after`, N=14, 2 clients, 0.5 simulated hours:
  vitest reported 5.7 s, 65 s wall including `npx` start-up.
- Not measured: every other scenario on any machine at a usable load. Cost grows with simulated hours x rows x
  clients; the 24 h and 48 h detection sweeps and the N=200 serve run are the long ones. During D2 the shared Mac
  was at load 150-300 and those runs were killed at their limit, so there is no honest per-scenario number yet.
  The m4-air run is what will produce them.

Start with a smoke run of three names before the full list:

```sh
src/main/github/__experiments__/run-specs.sh src/main/github/__experiments__/specs2.txt 3 \
  '^(serve-after-n14-c2|ghes-desk-after-default-n10-focused|serve-before-n14-c2)$'
```

## What each scenario measures (`specs2.txt`)

Name parts: `ghes|dotcom` host kind; `desk` desktop path or `serve` paired-client path; `before` is current code,
`after` is the proposal; cadence `default|reduced|minimal|off` (#40541's setting, modelled); `nN` rows;
`cN` paired clients.

| Scenarios | What they measure |
| --- | --- |
| `ghes-desk-{before,after}-{default,reduced,minimal,off}-n{10,50}-focused` | Desktop `gh` spawns per hour, by kind, per cadence, focused window |
| `…-unfocused`, `…-hidden`, `…-unfocused-noidle` | Effect of the 5-minute unfocused pause (and of turning it off) |
| `…-return` | Catch-up after focus returns at 30 min: spawns before, in the next 15 min, burst length |
| `…-mixed` | Same with 1 in 5 linked rows running CI (half of those with a failed check too) |
| `dotcom-desk-*` | Desktop path on github.com (single sidebar GraphQL read instead of the GHES three) |
| `…-focused-j0`, `…-j25` | Jitter 0 and 25% against the default 10%: peak and peak-to-mean |
| `…-detect`, `…-detect3` | Detection latency of external CI start/finish events (samples/p50/p90/max seconds) |
| `serve-before-*` / `serve-after-*` | Paired-client path: upstream starts, starts per 5 min, gate admits per lane, cache hits, last-good served over budget, cold deferrals, queue age per client, client failures |
| `serve-*-settled` | Same with no CI running |
| `serve-*-n200-c1`, `serve-*-n50-c3`, `…-disjoint` | Saturation: 200 rows; 3 clients; one client with 5 rows nobody else sees |
| `serve-oldclient-*` | A legacy client (no `selected`, ignores hints) against the new host |
| `serve-*-reduced-*`, `serve-*-ghes-*`, `serve-*-unfocused` | Cadence, GHES host and unfocused variants of the serve path |
| `serve-*-detect*`, `-seed2`, `-j0` | Detection latency on the serve path, second seed, no jitter |

`table2.py` prints, per scenario: spawns per hour, last-hour `pr:view`+sidebar starts, `auth:status` and
`api:rate_limit` spawns, rolling 60 s peaks, worst 15-min peak-to-mean, and for serve runs the gate counters.

## Known limits

- Counts are `gh` spawns. One spawn is one HTTP request except `gh auth status` (3 requests on a two-login machine).
- #40541's cadence is modelled (interval x1/x5/x10, Off = no timed interval); the harness does not run on that branch.
- Simulated host: no real GHES, no real paired transport, no upstream errors.
