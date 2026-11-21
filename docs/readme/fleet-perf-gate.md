# Fleet perf gate

A real-app OLD vs NEW check at fleet scale (~1,900 workspaces, ~1,800 chat tabs, synthetic). It exists because some regressions only show when every workspace pays: an idle desktop that sends itself 143 tab-update frames per second looks fine with 10 workspaces.

```sh
pnpm perf:fleet-gate --old <base-ref> [--new HEAD] [--runs 2] [--scenarios idle,typing,streaming,switch,burst,chat-memory] [--chat-settle-ms 120000] [--out <dir>]
```

It runs from any checkout with dependencies installed (`pnpm install`), on Linux or macOS. Refs can be commits, branches or tags; one that isn't local yet is fetched from origin.

It is a no-op unless the change touches a hot path (main process, preload/IPC, shared contracts, renderer stores, runtime/session sync, renderer hooks). Otherwise it prints `skipped: no hot-path changes` and exits 0. `--force` runs it anyway; `--paths-only` only reports the filter result. The filter lives in `config/scripts/performance/fleet-gate/fleet-gate-hot-paths.mjs`.

## What it does

1. Builds OLD and NEW in e2e mode, each in its own shared clone under `~/.cache/orca-fleet-gate/builds/<sha>` (cached by commit; the newest four are kept).
2. Seeds a synthetic fleet once per OLD commit (below). For each run, clones the seed into a throwaway user-data dir and home, launches the copy hidden, waits for the session to load, and lets it settle (`--settle-ms`, 120 s).
3. Measures up to four windows: `idle` (60 s, no input), `typing` (10 keys/s into the first visible input), `streaming` (20 agent hook events/s across 10 workspaces, through the real hook endpoint) and `switch` (click the titles of two workspace cards in turn, once a second). Before measuring, each copy answers the worktree-cards intro and keeps classic cards. Builds that have the intro otherwise preview the new cards, and the click would land on something different in OLD and NEW.
4. Runs a launch burst once, on NEW only (`burst`). It quits with 25 native chats mid-turn, then restarts with every core loaded and continues them all in one call, the way the restart dialog's Continue does. Then it starts 25 new chats at once. Each chat runs the repo's stream-json Claude stub (`tests/e2e/fixtures/structured-claude-stub.cjs`) through the real native-chat launch path, provider ownership included, so no model is called. It fails if any chat doesn't start, fewer restart offers come back than chats quit mid-turn, any continuation is refused, or any `Cannot establish provider process ownership` refusal is logged. OLD runs no burst: the result is absolute, so OLD's would only add a second fleet launch under full CPU load. To see whether a burst failure predates the change, rerun with `--old <old-ref> --new <old-ref> --scenarios burst --force`, plus the same `--seed` if the run used one (`--old` keeps the seed fleet the same, and `--force` runs the burst even though the refs change no hot path).
5. Checks main's memory per idle chat once, on NEW only (`chat-memory`). It starts 10 native chats on the stub, lets each finish its first turn, and waits `--chat-settle-ms` (2 min). Then it sends a simulated memory-pressure signal, waits a minute, and reads main's private memory footprint (`process.getProcessMemoryInfo().private`) as the lowest of 12 samples over a minute. Unlike RSS, it still counts pages a loaded machine swapped or compressed, which otherwise read as a drop. Then it starts 190 more in other workspaces and reads again the same way. It fails if main grew by more than 0.75 MB per added chat. The pressure signal matters: right after a burst of chats, main holds 50-120 MB of freed V8 pages from the burst's churn. V8 otherwise returns those over several minutes. Memory a build really keeps per chat survives the signal: on the seed, main reads 0.27-0.40 MB per chat (each live chat's processes and pipes cost main a little), and a build that keeps an extra 1 MB per chat reads 1.31. It needs the synthetic seed's 1,800 worktrees (a smaller `--seed` reports INCOMPLETE).
6. Runs OLD and NEW alternately (`--runs` pairs, counterbalanced) so drift on the machine hits both.

On Linux each copy gets a private Xvfb display (install `Xvfb`; without it the copy runs headless). macOS has no private display, and the gate never shows a test window, so copies stay hidden and unpainted. Clicks and keyboard focus need paint, so on macOS the default scenarios are `idle,streaming,burst,chat-memory`; `--scenarios` can still ask for `typing` or `switch`. Compare macOS numbers with macOS numbers only.

## What it counts

| Metric                                                 | Where                                                                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| M→R msg/s, R→M msg/s                                   | every `webContents.send`, `ipc-message` and `invoke` in main                                                                                    |
| no-op M→R msg/s                                        | a message identical to the previous one on the same channel, subscription and workspace once version, sequence and timestamp fields are removed |
| store pubs/s, no-op store pubs/s, subscriber wakeups/s | a conditional breakpoint on the store notify loop: one publication, how many listeners it woke, and whether any top-level field changed         |
| long tasks ms/s                                        | renderer `longtask` entries                                                                                                                     |
| main stalls >100ms, main stall max ms                  | a 50 ms timer's lateness in main                                                                                                                |
| main heap MB, renderer heap MB                         | at the end of each window                                                                                                                       |

The probes cost the same on both builds, but they do add overhead, so compare OLD with NEW, not with numbers taken without the gate.

## Verdict

A metric fails when every NEW run is worse than every OLD run by more than the metric's relative and absolute margins (`METRICS` in `fleet-gate-report.mjs`). In the idle window, NEW also fails above a fixed ceiling (`IDLE_CEILINGS`) unless OLD is already over it, which prints `WARN`.

A run that didn't do what it measures can't pass. If any run of either build had a workload that didn't happen, or a probe or metric that's missing, the result is `INCOMPLETE` and each gap is printed as an `incomplete:` line. Examples:

- fewer than 80% of the planned workspace switches landed;
- more than 20% of the hook posts failed;
- no typed key reached main;
- the fleet loaded fewer than 1,900 workspaces;
- the store probe found no notify loop.

| Exit | Result                                                        |
| ---- | ------------------------------------------------------------- |
| 0    | `RESULT: PASS`, or `skipped: no hot-path changes`             |
| 1    | `RESULT: FAIL`: NEW regressed (the line names the rows)       |
| 2    | `RESULT: INCOMPLETE`, or the gate couldn't build, seed or run |

## Release candidates

To compare a release candidate with the last release, run this from a clean checkout of `main` (the gate's code comes from the checkout; both builds come from their tags):

```sh
pnpm install
pnpm perf:fleet-gate --old <last-release-tag> --new <candidate-tag-or-sha> --force --out ~/fleet-gate/<candidate>
```

For example, `--old v1.4.262 --new v1.4.263`.

- `--force` is required: a release always runs, even if the hot-path filter finds nothing.
- Each tag is built from its own source in e2e mode, the same code as the release but not the signed artifact. Packaged apps (`--old-app`/`--new-app`) are refused because they don't expose the store the gate drives and probes.
- Runtime: on the 28-core Linux QA machine, v1.4.261 vs v1.4.262 took about 35 minutes cold (building both tags and seeding the fleet took about 10 minutes) and 25 minutes once both builds and the seed were cached. Builds are cached under `~/.cache/orca-fleet-gate/builds` and the seed per old tag. A laptop takes longer: allow 90 minutes cold. Keep about 15 GB of disk free; set `ORCA_FLEET_GATE_CACHE` to put the cache somewhere else.
- PASS means no metric got worse beyond its margin, at fleet scale, in any scenario, and all launches in the burst started. FAIL names the scenario and metric that regressed. Check the raw numbers before blocking: two `--runs` pairs is the minimum, and a FAIL with one pair at the margin should be rerun with `--runs 4`. INCOMPLETE means the run couldn't show anything; rerun it or report the `incomplete:` lines, but don't treat it as a pass. A FAIL that also prints `incomplete:` lines comes from a run that didn't fully drive its workload: rerun it before blocking.
- Runs on one machine can overlap safely: each cache entry is built under a lock, and each copy's terminal daemon is stopped when it quits. They share the machine's cores, though, so their numbers get noisy. Run candidates one at a time. If a run is killed while building, its lock stays behind, and the next run stops with exit 2 and prints the `rm -rf` that clears it.
- A killed run leaves nothing running. Each run works in `~/.cache/orca-fleet-gate/runs/<id>`, never `/tmp`; copies get their `TMPDIR` there too. The folder records its owner (pid and start time) and every copy it launched. On any exit the gate kills its copies' process groups and their terminal daemons. The next run reaps folders whose owner is gone, including after SIGKILL, a timeout or a lost host: it stops their recorded copies and verified daemons, then deletes the folder.
- Results go to `--out` (default `~/.cache/orca-fleet-gate/reports`): `fleet-gate-<old>-<new>-<time>.txt` is the table that was printed, `.json` has every run's raw numbers, and a screenshot of each copy after settling is saved next to them.

## Launch bursts and macOS

On Linux, a launch's process-ownership check reads `/proc` directly and can't time out. The 2 s read timeout that broke #42760's restart burst exists only on macOS (`provider-process-row-read.ts`). The Linux burst therefore guards launches at fleet scale, but it can't reproduce that timeout. Two layers cover it:

| Layer                                                                         | Runs                                         | Triggered by                                                                                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Linux launch burst (`burst` scenario)                                         | This gate, on the Linux QA machine           | Any hot-path change (above)                                                                                                  |
| macOS launch burst: `pnpm perf:fleet-gate --scenarios burst --force` on a Mac | On demand, and in every release run on a Mac | Launch, restart or process-ownership changes (`fleet-gate-hot-paths.mjs --launch-paths` exits 11 when a change touches them) |

## Seed

The gate builds its own synthetic fleet; no real user data is involved. It makes one small git repo with 1,800 linked worktrees plus 100 plain folders (`~/.cache/orca-fleet-gate/corpus`). Then it adds them through the app's own APIs, creates 1,800 chat tabs at rest (no agent process runs) and 200 terminals. A seed short of any of these is refused rather than cached. The seed is built by the OLD build, so NEW opens it the way an upgrade would. It is cached per OLD commit (`seeds/<sha>`, newest two kept), and each run starts from a copy-on-write clone of it. The table header prints the census read back from the app after settling. `--seed <user-data dir>` (or `ORCA_FLEET_SEED_DIR`) measures on an existing profile instead.

## Why not CI

It needs two app builds and 45 minutes or more of a quiet machine, and wall-clock rates on shared hosted runners are too noisy for 25% margins. Count contracts that need neither (`pnpm test:perf:contracts`) stay in CI.
