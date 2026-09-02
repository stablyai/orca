# Renderer agent-status performance

## Status

This design is adopted for the renderer's high-frequency agent-status path. It
keeps the existing event semantics while bounding the amount of synchronous
store fanout performed for one IPC burst.

It lands in slices. This document and the `bench:idle-cpu` harness land first so
the store changes can be reviewed against a baseline someone else measured. Until
the store slice lands, the `setAgentStatuses` / `transactAgentStatuses` actions
and the agent-status write workload described below are not yet on `main`; the
harness measures scale, listener census, and raw publication fanout only.

## Context

Orca can display a large expanded worktree lineage inside one virtualized list
row. Virtualizing the root row does not virtualize its descendants, so a
100-worktree lineage can mount 100 `WorktreeCard` instances at once.

Agent-status IPC events are bursty. The renderer already groups live events into
a 33 ms window, but the original flush applied every queued event with a
separate Zustand write. Zustand synchronously visits every listener for every
publication. The resulting work therefore grew with both the number of status
events and the number of mounted subscriptions:

```text
burst work ~= status events x store listeners x selector work
```

A production trace captured the renderer repeatedly entering
`flushLiveAgentStatusBurst -> applyAgentStatus -> setAgentStatus -> setState`
through `Set.forEach`. A deterministic 100-worktree fixture reproduces the
structural multiplier; see "Baseline on `main`" below for the currently measured
listener count and publication cost.

The production app later recovered substantially when all configured remote
hosts were removed. Host removal can stop relay/reconnect traffic, remove
mounted remote worktrees, or both, depending on host type and removal options.
That observation identifies remote presence as the production trigger but does
not by itself distinguish traffic volume from mounted-listener fanout.

A read-only reconnect audit ruled out systematic double status emission from a
full PTY replay: replay bytes bypass OSC status parsing. Reconnect still causes
a full terminal-buffer repaint for every attached remote pane, which is a
separate source of renderer work and remains a follow-up investigation.

## Goals

- Keep a large expanded lineage responsive during dense agent-status traffic.
- Preserve every ordered status transition, including repeated updates for one
  pane inside the same burst.
- Publish agent-status state once for a deferred live burst.
- Preserve selector identity and child render isolation.
- Make the regression reproducible without relying on a user's production data.

## Non-goals

- Changing the client/server status payload or remote protocol.
- Deduplicating status events by pane.
- Changing agent freshness, retention, history, title, completion, or provider
  session behavior.
- Changing remote reconnect, PTY replay, or terminal repaint behavior.
- Redesigning lineage presentation or collapsing worktrees automatically.

## Design

### Bound mounted subscription fanout

Sidebar components select cohesive state bundles with shallow equality instead
of registering one listener per field. Derived arrays and maps retain their
existing shallow identity behavior so unrelated store writes do not rerender a
card. Full agent-list mode keeps its child-level subscription boundary; compact
mode passes the already selected rows to avoid selecting the same inputs twice.

The deterministic 100-worktree fixture pins the resulting listener budget:

| Surface                        | Listener budget |
| ------------------------------ | --------------: |
| Worktree card state and caches |               2 |
| Agent-row inputs               |               1 |
| Worktree activity status       |               1 |
| Closed context menu            |               1 |

Unmount tests require the listener count to return to its prior baseline. In the
bundled prototype, the fixture without seeded agents fell from 8,518 listeners
to 1,218; with 100 visible agent rows the candidate mounted 1,618. Compare
against the census in "Baseline on `main`", which the harness reports directly.

### Share working-spinner phase without per-element animation queries

Working rows keep the existing compositor-driven CSS animation and shared
visual phase. Each mount derives one negative animation delay from the document
timeline instead of querying `getAnimations()` and mutating the animation start
time. This removes per-row Web Animations setup from dense status transitions
without adding a JavaScript animation clock.

### Fold a burst in event order

The store exposes the single-update action and two batch forms:

- `setAgentStatus(paneKey, payload, ...)` retains the positional single-update
  API for the immediate live path.
- `setAgentStatuses(updates)` applies a prebuilt ordered list, while
  `transactAgentStatuses(operation)` lets IPC derive each update against the
  exact staged state before the single commit.

Both entry points reuse the same single-update state transition. The batch
reducer passes each resulting state into the next update, so a sequence such as
`working -> waiting -> done` retains the same history and timestamps as three
sequential calls. Updates are never keyed or deduplicated before the fold.

The live IPC queue is spliced before it is processed. This preserves the
existing reentrancy guarantee: a synchronous subscriber can enqueue another
event without causing the current queue to be drained recursively. The first
event outside an active burst remains immediate; events accumulated within the
33 ms window are applied as one ordered transaction. Startup snapshots and
bounded pending-hydration retries use the same transaction path instead of
publishing once per restored pane.

Each transaction builds pane-routing ownership once with the same first-match
semantics as the standalone resolver. Split-layout leaf membership is indexed
once per layout root, so a large snapshot performs linear tab and leaf work
instead of rescanning every mounted worktree for every pane.

### Run effects after the transaction

Generated-title work that requires committed state is deferred until after the
transaction. Accepted updates also request freshness scheduling; the outer batch
coalesces those requests and schedules the shared freshness timer once after its
single commit. Generated-title requests are folded in event order and published
together, including first-write and forced-replacement semantics. Resolved tab
titles are projected while the transaction folds, then final title changes are
published together. Completion-triggered review refreshes remain deferred
microtasks.

Bulk title application preserves event order and duplicate-tab behavior while
indexing owners once, cloning each changed owner array once, and replacing each
top-level map once. This keeps the post-commit title phase linear in mounted
tabs plus changed titles.

This separation is important: invoking store actions from inside a Zustand
updater would re-enter the store, while running an effect before the commit
would let it observe stale state.

## Semantic invariants

Sequential and batched application must agree on:

- live and retained agent maps;
- state history, `updatedAt`, and `stateStartedAt`;
- agent identity, model, prompt, tools, assistant messages, and subagents;
- orchestration and provider-session continuity;
- sleeping-session and launch-config recovery records;
- retired/closed-pane rejection and inherited-status suppression;
- retention cleanup and live-map eviction;
- `agentStatusEpoch` and `sortEpoch`;
- automation completion observation across intermediate transitions;
- generated-title inputs, freshness scheduling, and completion refreshes.

Equivalence tests use fixed timestamps and include repeated same-pane
transitions. A publication-count test subscribes to the real store and requires
one notification for a non-empty batch and none for an empty batch.

## Benchmark contract

The benchmark launches an E2E-mode Electron build with the store exposed only
for instrumentation. It creates 100 worktrees in one expanded lineage, verifies
100 mounted cards, captures the store listener census, and then applies seeded
ordered agent-status traffic through the real store action.

The benchmark measures the synchronous store action, not the live IPC leading
edge or post-commit notification path. A real-store snapshot test covers the
end-to-end budget for 100 panes with auto-generated titles enabled: one status,
one bulk generated-title, and one bulk resolved-title publication. Disabling
generated titles removes that middle publication, independent of pane count.

The artifact records only fixed diagnostic fields needed for comparison:

- requested and completed batches and updates;
- store action calls and observed publications;
- elapsed time, throughput, and scheduling drift;
- final-state verification;
- renderer mean, p95, and maximum CPU;
- renderer timer drift and long tasks;
- mounted-card and listener counts.

Raw process inventories, temporary paths, pane identifiers, and DOM text are
diagnostic-only and must not be embedded in the shareable report.

Run baseline and candidate on the same machine and OS with the same Electron
build mode. CPU samples from macOS and Linux are comparable within that
constraint; Windows process CPU collection currently cannot support this
comparison.

## Harness

`pnpm run bench:idle-cpu` drives `config/scripts/run-idle-cpu-benchmark.mjs`,
which composes four modules:

| Module                                | Responsibility                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `idle-cpu-renderer-scale-fixture.mjs` | Seeds the lineage, agent rows, and sidebar view state; takes the mounted-card and listener census |
| `idle-cpu-renderer-timing-probe.mjs`  | In-page timer drift and long-task probe; runs the no-op publication workload                      |
| `idle-cpu-process-sampling.mjs`       | Classifies the Electron process tree and samples per-role CPU/RSS                                 |
| `idle-cpu-synthetic-spinners.mjs`     | Measurement-only visible spinners                                                                 |

The sampling window extends past `--sample-ms` until the workload settles, and
fails the run rather than reporting a truncated window if the workload overruns
the guard. That is why a 2,000-publication run reports a measured window longer
than the requested one.

`--zustand-publications` publishes an empty partial through the real store, so
each publication costs exactly one full subscriber visit and nothing else. It
isolates the `listeners x selector work` half of the burst-cost model from
agent-status payload work, and it is store-API independent — it measures the
same thing before and after the batching slice.

The agent-status write workload (`--agent-status-batches`,
`--agent-status-write-mode`) is not in this harness yet. It depends on
`setAgentStatuses`, so it lands with the store slice.

## Baseline on `main`

Measured on `main` at `077f5a11cd4` (macOS, arm64, 16 CPUs), Electron built with
`electron-vite --mode e2e`, headless, 100 worktrees at lineage depth 99 with 100
seeded agent rows, 10 s warmup and a 30 s sampling window.

Fixture scale is confirmed by the census rather than assumed: 100 store
worktrees, 100 mounted cards, 100 mounted agent rows, and **9,279 store
listeners**. That listener count is the multiplier the design targets.

2,000 no-op store publications at a 1 ms cadence, three repetitions. The
listener census was 9,279 in every run.

| Measure                  |      Median | Runs                           |
| ------------------------ | ----------: | ------------------------------ |
| Wall time to complete    | 12,325.7 ms | 13,148.6 / 12,325.7 / 11,870.5 |
| p50 scheduling drift     |  5,150.3 ms | 5,432.3 / 5,150.3 / 4,945.2    |
| p95 scheduling drift     |  9,802.9 ms | 10,570.4 / 9,802.9 / 9,390.0   |
| Renderer mean CPU        |      18.25% | 20.25 / 18.25 / 15.88          |
| Renderer p95 CPU         |      32.59% | 40.07 / 32.59 / 31.28          |
| Renderer timer drift p95 |      7.0 ms | 7.3 / 5.3 / 7.0                |

2,000 publications requested over 2 s take about 12 s, so the renderer sustains
roughly 160 publications per second at this scale. Each publication is
individually short - the long-task observer recorded zero entries in all three
runs - so the cost surfaces as scheduling drift and sustained CPU rather than as
discrete long tasks. Compare drift and CPU here, not long-task counts.

The idle control at the same scale with `--zustand-publications 0` reports 6.63%
renderer mean CPU, 17.11% p95, and 1.6 ms p95 timer drift. Roughly 11.6 points
of mean renderer CPU are therefore attributable to publication fanout rather than
to the mounted fixture itself. 200 spinner animations run in both cases, so the
control also bounds the animation cost out of the comparison.

Reproduce with:

```bash
pnpm run bench:idle-cpu -- --worktrees 100 --lineage-depth 99 \
  --agents-per-worktree 1 --warmup-ms 10000 --sample-ms 30000 \
  --zustand-publications 2000 --zustand-publication-interval-ms 1 \
  --output /tmp/idle-cpu-baseline.json
```

## Results

Three repetitions used 100 mounted worktrees, lineage depth 99, 100 seeded
agent rows, and verified final state. Medians from the regenerated evidence set
are:

| Single 2,000-update burst | Sequential |    Batched |
| ------------------------- | ---------: | ---------: |
| Status-state publications |      2,000 |          1 |
| Store action time         | 3,692.0 ms |   188.7 ms |
| Update throughput         |    541.7/s | 10,598.8/s |
| Renderer mean CPU         |      36.2% |       2.9% |
| Renderer p95 CPU          |     107.3% |       8.2% |
| p95 long task             |   4,653 ms |     216 ms |

The direct store transaction performs 99.95% fewer status-state publications,
spends 94.9% less time in the store action, and processes updates 19.6 times
faster. Renderer mean CPU falls 92.0%, renderer p95 CPU falls 92.4%, and the p95
long task falls 95.4%.

The 60-burst × 32-update case at 33 ms is a sustained saturation stress, not a
real-time production SLO. Publications fall from 1,920 to 60 and median store
action time falls from 2,791.9 ms to 323.3 ms. Median completion time falls from
5,298.2 ms to 2,710.6 ms, p95 scheduling drift falls from 3,073.0 ms to 664.9
ms, and long-task count falls from 57 to 1. Renderer p95 CPU remains saturated
and noisy in this cadence, so it is not used as the discriminating measure.

The 20-pane artificial OpenCode regression passes with 12.4 ms median key echo,
25.2 ms worst key echo, 19.4 ms maximum timer drift, and zero dropped renderer
backlogs.

These figures come from the bundled prototype and are restated here as the
target. They are re-measured with the harness when the store slice lands.

## Acceptance criteria

- The 100-worktree fixture stays at or below the pinned listener budgets.
- A deferred transaction performs one status-state publication while preserving
  ordered final state, including live-map eviction at the 500-row cap.
- A 100-pane startup snapshot performs one status and one bulk resolved-title
  publication with generated titles disabled; enabling generated titles adds at
  most one ordered bulk publication while preserving final statuses and titles.
- Sequential-versus-batch equivalence tests pass across same-pane transitions
  and side-effect-bearing updates.
- Renderer CPU tails and scheduling drift improve in repeated candidate runs.
- The 20-pane artificial terminal test reports no dropped output backlog and no
  material typing-latency regression.
- Web typecheck, focused unit tests, lint, max-lines ratchet, and E2E build pass.

## Compatibility

This is renderer-local. It adds no RPC field, stream opcode, persisted data, Git
command, or provider-specific contract. Native, WSL, SSH, relay, folder
workspace, and git-worktree status events enter the same renderer action. Mixed
client/server versions therefore need no capability negotiation.

## Failure containment

The first live event remains immediate. Startup replay and bounded pending
retries fold synchronously without waiting for the 33 ms live-burst window, but
publish their accepted updates together. Empty batches are no-ops. If an update
is stale or targets retired authority, the reducer skips only that update and
continues folding later events in order.
