# Terminal Model/View Contract

## Goal

Terminal output should have one authoritative model path and many disposable
views. A renderer xterm is the fast interactive view, but it must not be the
only place hidden, remote, mobile, SSH, or CLI-visible terminal state exists.

This contract defines the boundary the shipped terminal stack implements — and
that future terminal work must preserve — without changing the query-response
behavior that real shells and TUIs depend on. See [Architecture
Status](#architecture-status) for the shipped phases.

## Terms

- **PTY stream:** Ordered bytes read from a local PTY, daemon PTY, SSH relay PTY,
  or remote runtime PTY.
- **Terminal model:** Main/runtime-owned state derived from PTY bytes. Today this
  is mostly the headless emulator plus retained read transcript state.
- **Terminal view:** A renderer xterm, mobile subscriber, remote desktop
  subscriber, or CLI read page consuming model state and live output.
- **Snapshot:** A bounded model serialization that can restore a view without
  replaying an unbounded byte log.
- **Transcript:** The retained output contract for `orca terminal read`; it is
  line/cursor oriented and distinct from a screen snapshot.

## Non-Negotiable Invariants

1. PTY reads do not stop to protect renderer performance. Backpressure may bound
   delivery to views, but terminal state, notifications, titles, and agent
   status keep advancing from the PTY stream.
2. Active visible terminal input/output stays on the lowest-latency path. Bulk
   hidden or background output must not delay keystroke-sized foreground redraws.
3. Hidden views do not own unbounded output memory. Main's hidden-delivery
   gate drops renderer-bound bytes for hidden-marked PTYs after model
   ingestion and emits an out-of-band restore marker
   (`pty:modelRestoreNeeded`) so the view restores from the model on reveal.
   With the gate's kill switches off, hidden bytes ride a bounded renderer
   queue whose overflow latches the same model restore.
4. Returning to a hidden or slept terminal must show model-correct output. A
   stale or replaced view may be cleared and replayed from a snapshot, but it
   must not show a warning fallback when model recovery is available.
5. Snapshots and live bytes have ordering metadata. A view restore must not
   duplicate bytes already included in the snapshot or drop bytes that arrived
   after it. Main buffer snapshots report the pending-delivery start sequence
   (`pendingDeliveryStartSeq`) so the renderer reconciles live chunks racing a
   restore without misreading foreign sequence domains as duplicates.
6. Terminal query authority is singular and structural: the party that
   writes a chunk into a live terminal answers its queries. Visible renderer
   and remote views keep xterm authority. Chunks dropped by the
   hidden-delivery gate are answered exactly once by the main model
   responder, from runtime-emulator state plus renderer-pushed view
   attributes. Replayed, seeded, or snapshot bytes are answered by no one.
   The daemon emulator never answers. (Amended by Phase 5 — see
   [`terminal-query-authority.md`](./terminal-query-authority.md).)
7. The transcript contract stays separate from screen restore. `orca terminal
   read` must preserve bounded previews, cursor pagination, partial-line rules,
   truncation flags, and total counts even if view snapshots change shape.
8. Local, daemon, SSH, remote runtime, mobile, and CLI paths must either satisfy
   the same model/view contract or explicitly report that model recovery is
   unavailable.

## Current Owners

| Responsibility | Current owner |
| --- | --- |
| PTY byte source and local/SSH delivery | `src/main/ipc/pty.ts` |
| Hidden-delivery gate (hidden marks, delivery interest, drop accounting, restore markers) | `src/main/ipc/pty-hidden-delivery-gate.ts`, drop sites in `src/main/ipc/pty.ts` and `src/main/ssh/ssh-relay-session.ts` |
| Side-effect parsing and the `pty:sideEffect` facts channel | `src/shared/terminal-output-side-effects.ts` driven from `OrcaRuntimeService.onPtyData`; renderer policy in `src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler.ts` |
| Model query responder and view-attribute bridge | `src/main/runtime/terminal-model-query-authority.ts`, `src/main/daemon/terminal-view-attribute-responder.ts`, `src/main/runtime/terminal-view-attribute-store.ts` |
| Hidden view parking policy and parked watcher | `src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts`, `parked-terminal-byte-watcher.ts` |
| Daemon PTY state and headless snapshots | `src/main/daemon/headless-emulator.ts` |
| Runtime headless state, retained reads, mobile/session tabs | `src/main/runtime/orca-runtime.ts` |
| Remote terminal subscribe/multiplex/ACK semantics | `src/main/runtime/rpc/methods/terminal.ts` |
| Renderer xterm view and hidden restore behavior | `src/renderer/src/components/terminal-pane/pty-connection.ts` |
| Remote desktop runtime xterm transport | `src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts` |

## Snapshot Contract

A model snapshot must include:

- terminal dimensions used to produce the snapshot;
- enough ANSI state to rehydrate xterm before snapshot content;
- bounded screen and scrollback content;
- title and cwd metadata when known;
- source metadata that distinguishes headless/model snapshots from renderer
  fallback snapshots;
- monotonic ordering metadata for live-output reconciliation when available.

A snapshot must not:

- include unbounded transcript history;
- answer terminal queries while replaying into the model;
- overwrite newer live view output with older model output;
- hide that recovery was unavailable for a PTY surface.

## View Contract

A renderer or remote view may:

- write active visible output immediately;
- budget visible inactive output;
- stop receiving hidden output entirely while main's hidden-delivery gate owns
  the bytes (model restore on reveal);
- request fresh snapshots for restore, mobile subscription, or explicit remote
  snapshot recovery.

A view must:

- keep live-output buffers bounded while a snapshot is in flight;
- apply generation or sequence checks before replaying a snapshot;
- refresh/repaint after replay when xterm/WebGL needs an explicit paint;
- keep side effects such as title, bell, cwd, and agent status flowing from the
  PTY/model path (the `pty:sideEffect` facts channel) even while renderer byte
  delivery is budgeted, gated, or parked.

## Transcript Contract

The retained read transcript is not a screen dump. It must preserve:

- uncursored bounded latest preview behavior;
- cursor reads over completed retained lines;
- `oldestCursor`, `nextCursor`, `latestCursor`, and `returnedLineCount`;
- partial-line duplication rules;
- `truncated`, `limited`, and total count metadata;
- bounded memory for long partial lines and large output bursts.

Snapshot optimizations must be tested against this transcript contract instead
of assuming xterm scrollback serialization can replace it.

## Required Contract Tests

Before moving more runtime behavior behind the model/view boundary, add or
extend tests that prove:

- headless snapshots rehydrate rich alternate-screen TUI state;
- the daemon emulator never answers DA, DSR, OSC 11, or theme-sensitive
  queries (the `session.test.ts` pins are permanent);
- the main runtime responder answers queries only from live chunks the
  hidden-delivery gate dropped — never delivered, replayed, seeded, or
  remote-subscribed chunks;
- hidden renderer overflow restores from model state without duplicate live
  output;
- sleep/wake and worktree revisit restore from model-correct state;
- SSH-backed PTYs follow the same snapshot and ordering semantics as local PTYs;
- remote runtime multiplex output remains ACK bounded and can request recovery
  snapshots;
- mobile subscribers receive bounded snapshots without unbounded pending live
  output;
- retained terminal reads remain pageable and bounded after large output.

Current coverage is spread across:

- `src/main/daemon/headless-emulator.test.ts`
- `src/main/daemon/session.test.ts`
- `src/main/ipc/pty.test.ts` (hidden-gate drops, restore markers,
  `pendingDeliveryStartSeq`)
- `src/main/ipc/pty-hidden-delivery-gate.test.ts`
- `src/main/runtime/mobile-subscribe-integration.test.ts`
- `src/main/runtime/rpc/terminal-subscribe-buffer.test.ts`
- `src/main/runtime/rpc/terminal-multiplex.test.ts`
- `src/main/runtime/orca-runtime.test.ts`
- `src/main/runtime/terminal-query-responder.test.ts`
- `src/shared/terminal-output-side-effects.test.ts`
- `src/renderer/src/components/terminal-pane/terminal-title-tracker-parity.test.ts`
- `src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler.test.ts`
- `src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.test.ts`
- `src/renderer/src/components/terminal-pane/parked-terminal-byte-watcher.test.ts`
- `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.test.ts`
- `tests/e2e/terminal-hidden-tui-visual-restore.spec.ts`
- `tests/e2e/terminal-hidden-view-parking.spec.ts`
- `tests/e2e/terminal-parked-memory.spec.ts`
- `tests/e2e/terminal-sleep-wake-restore.spec.ts`
- `tests/e2e/terminal-output-scheduler.spec.ts`
- `tests/e2e/artificial-opencode-terminal-load.spec.ts`

## Architecture Status

All six phases of the terminal model/view architecture are shipped; the kill
switches noted in parentheses default on:

1. **Hidden view parking** — "Park hidden terminal views behind a byte
   watcher": hidden terminal tabs unmount their xterm after a cold-park
   hysteresis; a pane-less watcher keeps bell/title/agent/PR side effects
   alive while parked (`terminalHiddenViewParking`). See
   [`terminal-hidden-view-parking.md`](./terminal-hidden-view-parking.md).
2. **Parked memory benchmarks** — "Benchmark parked hidden terminal memory":
   renderer heap and live-terminal counts gate parking in the perf suite
   (`tests/e2e/terminal-parked-memory.spec.ts`).
3. **Side-effect authority in main** — "Track terminal titles in main with
   all-titles ordering", "Move terminal side-effect authority to a main facts
   channel", "Complete terminal side-effect facts coverage", "Finish terminal
   side-effect authority migration": every local/daemon/SSH PTY byte is
   side-effect-parsed once in main and delivered as `pty:sideEffect` facts
   (`terminalMainSideEffectAuthority`). See
   [`terminal-side-effect-authority.md`](./terminal-side-effect-authority.md).
4. **Hidden delivery gate** — "Gate PTY delivery to hidden terminal views":
   main drops renderer-bound bytes for hidden-marked PTYs after model
   ingestion; delivery-interest registrations exempt sidecar byte consumers,
   out-of-band restore markers latch model restore, and
   `pendingDeliveryStartSeq` reconciles live output racing a restore
   (`terminalHiddenDeliveryGate`).
5. **Model query authority** — "Answer hidden terminal queries from the
   model", "Bridge renderer view attributes to the model responder", "Align
   query authority contract and spawn-time ownership": hidden-dropped queries
   are answered by the runtime emulator plus renderer-pushed view attributes,
   and hidden-at-spawn PTYs are marked before byte one
   (`terminalModelQueryAuthority`). See
   [`terminal-query-authority.md`](./terminal-query-authority.md).
6. **Skip grammar deletion** — "Delete the hidden renderer skip grammar": the
   renderer's per-chunk hidden-skip eligibility grammar and the 10s codex
   startup query window are deleted; the kill-switch-off fallback is the
   bounded background queue with overflow-latched model restore.

Treat every hidden/slept/revisited TUI glitch as a contract failure, not as a
local repaint quirk. Renderer fallback paths retire only when their kill
switches do, and only after the equivalent model path has platform and TUI
golden coverage.
