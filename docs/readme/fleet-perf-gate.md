# Fleet perf gate

A real-app OLD vs NEW check at fleet scale (~1,900 workspaces, ~1,800 chat tabs, synthetic). It exists because some regressions only show when every workspace pays: an idle desktop that sends itself 143 tab-update frames per second looks fine with 10 workspaces.

```sh
pnpm perf:fleet-gate --old <base-ref> [--new HEAD] [--runs 2] [--scenarios idle,typing,streaming,switch]
```

It is a no-op unless the change touches a hot path (main process, preload/IPC, shared contracts, renderer stores, runtime/session sync, renderer hooks). Otherwise it prints `skipped: no hot-path changes` and exits 0. `--force` runs it anyway; `--paths-only` only reports the filter result. The filter lives in `config/scripts/performance/fleet-gate/fleet-gate-hot-paths.mjs`.

## What it does

1. Builds OLD and NEW in e2e mode, each in its own shared clone under `~/.cache/orca-fleet-gate/builds/<sha>` (cached by commit; the newest four are kept).
2. Seeds a synthetic fleet once per OLD commit (below). For each run, clones the seed into a throwaway user-data dir and home, launches the copy hidden, waits for the session to load, and lets it settle (`--settle-ms`, 120 s).
3. Measures four windows: `idle` (60 s, no input), `typing` (10 keys/s into the first visible input), `streaming` (20 agent hook events/s across 10 workspaces, through the real hook endpoint) and `switch` (click between two workspace cards once a second).
4. Runs a launch burst once per build (`burst`). It quits with 25 native chats mid-turn, then restarts with every core loaded and continues them all in one call, the way the restart dialog's Continue does. Then it starts 25 new chats at once. Each chat runs the repo's stream-json Claude stub (`tests/e2e/fixtures/structured-claude-stub.cjs`) through the real native-chat launch path, provider ownership included, so no model is called. NEW fails if any chat doesn't start, any continuation is refused, or any `Cannot establish provider process ownership` refusal is logged, whatever OLD did.
5. Runs OLD and NEW alternately (`--runs` pairs, counterbalanced) so drift on the machine hits both.

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

A metric fails when every NEW run is worse than every OLD run by more than the metric's relative and absolute margins (`METRICS` in `fleet-gate-report.mjs`). In the idle window, NEW also fails above a fixed ceiling (`IDLE_CEILINGS`) unless OLD is already over it, which prints `WARN`. Exit code 0 means PASS or skipped, 1 means FAIL, 2 means the gate could not run.

## Launch bursts and macOS

On Linux, a launch's process-ownership check reads `/proc` directly and can't time out. The 2 s read timeout that broke #42760's restart burst exists only on macOS (`provider-process-row-read.ts`). The Linux burst therefore guards launches at fleet scale, but it can't reproduce that timeout. Three layers cover it:

| Layer                                                                                                                                                                                                                                                                                  | Runs                                      | Triggered by                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contract tests: 25 concurrent ownership proofs whose first reads are all unverifiable must all publish (`provider-ownership-journal.test.ts`); a restart burst starts at most six continuations at once on a many-core host (`structured-agent-session-restart-resume-runner.test.ts`) | CI, every PR whose unit tests select them | Changes to those modules or what they import                                                                                                           |
| Linux launch burst (`burst` scenario)                                                                                                                                                                                                                                                  | This gate, on the Linux QA machine        | Any hot-path change (above)                                                                                                                            |
| macOS launch burst: the same scenario on the M4Air through the QA queue                                                                                                                                                                                                                | `fleet-gate --mac`, on demand             | Launch, restart or process-ownership changes (`fleet-gate-hot-paths.mjs --launch-paths`): the gate prints a reminder; add `--mac` for a real-app check |

## Seed

The gate builds its own synthetic fleet; no real user data is involved. It makes one small git repo with 1,800 linked worktrees plus 100 plain folders (`~/.cache/orca-fleet-gate/corpus`). Then it adds them through the app's own APIs, creates 1,800 chat tabs at rest (no agent process runs) and 20 terminals. The seed is built by the OLD build, so NEW opens it the way an upgrade would. It is cached per OLD commit (`seeds/<sha>`, newest two kept), and each run starts from a copy-on-write clone of it. The table header prints the census read back from the app after settling. `--seed <user-data dir>` (or `ORCA_FLEET_SEED_DIR`) measures on an existing profile instead.

## Why not CI

It needs two app builds and about 30 minutes of a quiet machine, and wall-clock rates on shared hosted runners are too noisy for 25% margins. Count contracts that need neither (`pnpm test:perf:contracts`) stay in CI.
