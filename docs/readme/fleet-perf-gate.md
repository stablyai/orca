# Fleet perf gate

A real-app OLD vs NEW check at fleet scale (~1,900 workspaces, ~1,800 chat tabs). It exists because some regressions only show when every workspace pays: an idle desktop that sends itself 143 tab-update frames per second looks fine with 10 workspaces.

```sh
pnpm perf:fleet-gate --old <base-ref> [--new HEAD] [--runs 2] [--scenarios idle,typing,streaming,switch]
```

It is a no-op unless the change touches a hot path (main process, preload/IPC, shared contracts, renderer stores, runtime/session sync, renderer hooks). Otherwise it prints `skipped: no hot-path changes` and exits 0. `--force` runs it anyway; `--paths-only` only reports the filter result. The filter lives in `config/scripts/performance/fleet-gate/fleet-gate-hot-paths.mjs`.

## What it does

1. Builds OLD and NEW in e2e mode, each in its own shared clone under `~/.cache/orca-fleet-gate/builds/<sha>` (cached by commit; the newest four are kept).
2. For each run, clones the seed into a throwaway user-data dir and home, launches the copy hidden, waits for the session to load, and lets it settle (`--settle-ms`, 120 s).
3. Measures four windows: `idle` (60 s, no input), `typing` (10 keys/s into the first visible input), `streaming` (20 agent hook events/s across 10 workspaces, through the real hook endpoint) and `switch` (click between two workspace cards once a second).
4. Runs OLD and NEW alternately (`--runs` pairs, counterbalanced) so drift on the machine hits both.

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

## Seed

The seed is a user-data folder holding `profiles/local-default/profile-state.db` and `agent-session-domain.db`. Make one from a real profile's two database files:

```sh
pnpm perf:fleet-gate --prepare-seed <dir with profile-state.db and agent-session-domain.db> [--seed <out dir>]
```

Preparing a seed empties SSH targets, remote PTY leases, automations and bots, so a test copy never connects to real hosts or starts scheduled agents. The default seed location is `~/.cache/orca-fleet-gate/seed` (`ORCA_FLEET_SEED_DIR` overrides it). Seeds hold a real user's workspace names and chats, so keep them on team machines and out of CI.

## Why not CI

The seed is real user data, and wall-clock rates on shared hosted runners are too noisy for 25% margins. Count contracts that need neither (`pnpm test:perf:contracts`) stay in CI.
