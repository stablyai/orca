# Terminal Side-Effect Authority

Status: Shipped — Phase 3 of the terminal model/view architecture, kill switch
`terminalMainSideEffectAuthority` (default on). Builds on
[`terminal-model-view-contract.md`](./terminal-model-view-contract.md) and
[`terminal-hidden-view-parking.md`](./terminal-hidden-view-parking.md) (Phase 1).

## Problem

Main parses every local/daemon/SSH PTY byte before renderer delivery
(`OrcaRuntimeService.onPtyData` in `src/main/runtime/orca-runtime.ts`:
side-effect tracker, OSC 9999 agent status, headless emulator, tails, URL
watchers; SSH feeds the same path from `wireUpPtyEvents` in
`src/main/ssh/ssh-relay-session.ts`). Before this phase, the side effects
users see — bell unread/notifications, title transitions, agent-complete
notifications, command lifecycle, PR links — were derived a second time by
renderer byte parsers. That duplication forced Phase 1's watcher to parse
bytes, forced main to fabricate synthetic OSC title frames over `pty:data`
just so renderer parsers could see them, and blocked Phase 4 from ever
stopping hidden byte delivery. Phase 3 made main the side-effect parser for
every PTY whose bytes transit local main; the renderer byte parsers
(`createPtyOutputProcessor` in `pty-transport.ts`, the parked watcher's byte
mode) survive only for remote-runtime PTYs and the kill-switch-off fallback.

## Authority Matrix

"Main" means parsed once in `onPtyData` and delivered as derived facts.
Remote-runtime PTYs (`remote:`) never transit local main; the renderer
(`remote-runtime-pty-transport.ts:74`) stays their parser permanently.

| Side effect | local-daemon | SSH | remote-runtime |
| --- | --- | --- | --- |
| OSC 9999 agent status | main (parsed in `onPtyData`, emitted as `agentStatus:set`) | main | renderer (`shouldOwnAgentStatusInRenderer`, `pty-connection.ts`) |
| OSC 0/1/2 titles + working/idle/exited tracker + 3s stale-title timer | main | main | renderer |
| BEL attention (OSC-aware stateful detector) | main | main | renderer |
| OSC 133;D command-finished exit code | main | main | renderer |
| GitHub PR-link scan | main | main | renderer |
| Command Code output scrape | main (per-PTY detector beside the tracker → `command-code-working`/`command-code-done` facts; the renderer pane keeps the done settle timer — it must consult the live status row) | main | renderer |
| DECSET 2031 color-scheme reply | renderer view/watcher — the 2031 fact reply path is untouched by Phase 5; general query authority is now per-chunk structural ownership, see [`terminal-query-authority.md`](./terminal-query-authority.md) (contract invariant 6 as amended) | same | renderer |
| DECSET 2004 paste readiness (`agent-paste-draft.ts`) | renderer — input pacing, not a model side effect | renderer | renderer |

## Main-Side Tracker

- The side-effect core shared with the renderer processor lives in
  `src/shared/terminal-output-side-effects.ts`: all-titles ordering via
  `extractAllOscTitles` (coalesced working→idle transitions are why last-title
  is insufficient — issue #1083), `normalizeTerminalTitle`, the literal
  `cursor agent` title drop (`CURSOR_NATIVE_TITLE_LOWER`,
  `src/shared/agent-detection.ts`), the `createAgentStatusTracker`
  transitions, the stale-working-title 3s timer
  (`STALE_WORKING_TITLE_TIMEOUT_MS`), and the stateful BEL detector
  (`src/shared/terminal-bell-detector.ts`).
- One tracker per PTY on `OrcaRuntimeService`, lazily created like
  `agentStatusOscProcessorsByPtyId`; disposed in `onPtyExit` (cancels the
  stale-title timer).
- It replaced the chunk-level last-title extraction in `onPtyData`: titles
  feed in byte order, so `lastOscTitle`/`lastAgentStatus`, tui-idle waiters,
  and pending-message delivery see intermediate transitions instead of only
  the chunk's last title. PTY/leaf records keep the **raw** last title
  (worktree `ps` and mobile tab titles expect raw); emitted facts carry
  `(normalizedTitle, rawTitle)` like `onTitleChange`.
- No deferred drain in main — the renderer's setTimeout(0) batching
  (`sideEffectDrainTimer`, `pty-transport.ts`) protects xterm paint, which
  does not exist in main. Main applies synchronously and batches the IPC per
  flush.
- The stats `AgentDetector` (`src/main/stats/agent-detector.ts`) keeps its own
  last-title scan, untouched: synthetic titles must never reach it.

## Event Transport: `pty:sideEffect`

One batched main→renderer channel (`window.api.pty.onSideEffect`,
`src/preload/index.ts`). It is **not** routed through the pty dispatcher:
the renderer fact-consumer registry
(`terminal-side-effect-facts-handler.ts`) subscribes directly via
`window.api.pty.onSideEffect` — one channel subscription per renderer, with
exactly one registered fact consumer per PTY. Events are **facts, not
decisions**: `title`, `bell`, `agent-working`, `agent-idle` (with title),
`agent-exited`, `command-finished` (exit code), `pr-link`. Each carries
`ptyId`, main-known attribution (worktreeId/tabId/paneKey from runtime leaf
records, same resolution as `emitTerminalAgentStatusEvents`), and the PTY
`outputSequence`.

Ordering rules:

1. Per-PTY in-order; facts from one chunk are emitted in byte order (status
   payloads, then titles in sequence, then bell — the renderer drain's order).
2. Deliberately **not** synchronized with `pty:data`: side effects must keep
   advancing while renderer delivery is ACK-gated (contract invariant 1). A
   completion title may reach the store before the visible xterm paints the
   final output; that is acceptable — attention/title state is out-of-band UI
   state, and today's renderer drain already decouples by many batches under
   timer throttling.
3. No attention replay: facts emitted while no renderer is subscribed are
   dropped. On transport attach/park-handoff the renderer pulls a title-only
   snapshot (`pty:sideEffectSnapshot`) marked `replay: true` — this reproduces
   the eager-buffer behavior where replay restores titles but is barred from
   bells/completions (`suppressAttentionEvents`, `pty-transport.ts`). The
   store handler ignores a replay title older (by `outputSequence`) than the
   last live title fact it applied.

## Renderer Store Handler (policy stays in the renderer)

Notification semantics, all preserved across the authority flip:

- BEL marks worktree+tab unread unconditionally — including the focused pane
  (`onBell`, `pty-connection.ts`); pane unread only behind
  `experimentalTerminalAttention`; keydown clears unread
  (`onTerminalKeyDown`, `pty-connection.ts`).
- BEL's OS notification is delayed 250 ms and yields to a pending
  agent-task-complete (`scheduleTerminalBellNotification`,
  `pty-connection.ts`).
- working→idle starts the Claude cache timer (null settings = not hydrated,
  treat enabled) and schedules completion with 250 ms grace + 1500 ms max
  wait + detail-wait store subscription
  (`AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS` /
  `AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS`,
  `agent-task-complete-policy.ts`).
- Completion unread is suppressed only for the exact visible foreground pane
  (`isVisibleForegroundPaneKey`, `use-notification-dispatch.ts`); BEL unread
  has no such check.
- Dispatch-time liveness/staleness guards
  (`dispatchTerminalNotification`, `use-notification-dispatch.ts`) and main's
  5 s per-worktree cooldown (`NOTIFICATION_COOLDOWN_MS`,
  `src/main/ipc/notifications.ts`) remain the final gates.

These need live renderer store state (PTY/layout maps, pane visibility,
settings, `agentStatusByPaneKey`, repo labels), so they stay in the renderer:
the pane-independent per-paneKey handler module
(`terminal-side-effect-facts-handler.ts`) consumes `pty:sideEffect` and
subsumes both `pty-connection.ts`'s callbacks and the parked watcher's
callback block (`sideEffectCallbacks`, `parked-terminal-byte-watcher.ts`) —
one policy path whether the tab is mounted, hidden, or parked. Main holds
**no** notification timers; only the stale-title timer (parser state) lives
in main.

## Synthetic Frame Reroute

`driveSyntheticTitleFromHook` and the spinner tick (`sendSyntheticTitle`,
`src/main/index.ts`) feed `runtime.ingestSyntheticTitleFrame(ptyId, data)`,
so synthetic agent-title/BEL frames enter the per-PTY tracker directly —
**not** `onPtyData`, so emulator state, tails, transcripts, and stats never
see them. The decorative-frame visibility gating
(`shouldSendSyntheticTitleFrame`) stands. The legacy synthetic `pty:data`
copy survives only in kill-switch-off mode, where renderer parsers still
need the bytes. The visible xterm renders nothing from titles, but
`pane.terminal.onTitleChange` feeds `registerPtyTitleSource`
(`pty-connection.ts`) → renderer serialize-snapshot `lastTitle` (mobile
parity); main prefers its own tracked title over renderer snapshot
`lastTitle` in both serialize paths. Under main authority synthetic frames
no longer produce phantom ACKs for bytes main never metered (`ackPtyData`,
`pty-dispatcher.ts`).

## Migration Switch and Double-Fire Prevention

Authority is structural per PTY kind — the predicate is "bytes transit local
main", exactly the `shouldOwnAgentStatusInRenderer` split
(`pty-connection.ts`). One renderer-consulted kill switch
(`settings.terminalMainSideEffectAuthority`, default on, mirroring
`terminalHiddenViewParking`): when on, IPC transports and the parked watcher
do not register byte parsers for local/SSH and the store handler consumes
`pty:sideEffect`; when off, renderer parsers register and `pty:sideEffect`
events are ignored. Main always parses and emits (its internal consumers need
the tracker regardless); main consults the same setting only to keep the
legacy synthetic-frame `pty:data` path alive while the switch is off. Exactly
one consumer per fact at any time — decided at transport/watcher creation, so
no per-chunk race.

## Sidecar Consumers and Phase 4

Keep renderer byte access (input pacing / raw-output consumers, not side
effects): `agent-paste-draft.ts` (DECSET 2004 readiness),
`launch-agent-background-session.ts` (startup-injection pacing, onData
passthrough), `automation-session-observer.ts` (onData passthrough), and
`parked-terminal-mode2031-responder.ts` (DECSET 2031 theme replies for
parked tabs while the delivery gate is off). Their duplicated local OSC 9999
store writes are gated off under main authority (the `onAgentStatus`
automation callbacks still fire; only the racing `setAgentStatus` store
writes drop). The Phase-4 hidden-delivery gate exempts PTYs with an active
`subscribeToPtyData` sidecar: registration is auto-surfaced to main as a
ref-counted delivery-interest signal (`pty-delivery-interest.ts`). With main
authoritative, the parked watcher is purely fact-driven: byte parsing exists
only in kill-switch-off mode, and the 2031 reply comes from the
`2031-subscribe` fact when the gate is on (the byte responder sidecar only
when it is off). The watcher file is deleted outright only when the kill
switch retires — it returns as a byte parser only if remote-runtime tabs
ever become parkable.

## Invariants

1. Every byte is side-effect-parsed exactly once, by exactly one authority,
   chosen structurally per PTY kind.
2. Attention facts never replay: snapshot/eager/attach replays restore title
   state only.
3. Notification policy (grace timers, yielding, suppression, dispatch guards)
   lives with the renderer store; main emits facts with ordering metadata.
4. Side-effect facts keep flowing while renderer byte delivery is
   backpressured, parked, or stopped by the hidden-delivery gate.
5. Synthetic agent frames feed the model tracker, never the emulator, tails,
   transcripts, or stats.

## Test Strategy

- Parity harness (`terminal-title-tracker-parity.test.ts`): shared byte
  fixtures (agent title cycles incl. coalesced chunks, BEL inside/spanning
  OSC, CAN/SUB cancellation, cursor-agent literal, stale-title timeout under
  fake timers, OSC 133;D, split PR URLs) run through the renderer
  `createPtyOutputProcessor` and the main tracker; assert identical ordered
  fact sequences.
- Unit: main tracker tests beside `orca-runtime.test.ts` (lastOscTitle
  parity, tui-idle waiter transitions, synthetic ingestion); store-handler
  tests reusing `parked-terminal-byte-watcher.test.ts` scenarios.
- Pinned tests that flip or retire: `pty-connection.test.ts` callback wiring,
  `parked-terminal-byte-watcher.test.ts` (retires with the watcher);
  `pty-transport*.test.ts` stay (processor remains for remote + kill switch).
- E2E gates that must stay green throughout: `terminal-attention.spec.ts`,
  `droid-notification.spec.ts`, `terminal-hidden-view-parking.spec.ts`,
  `terminal-parked-memory.spec.ts`; add main-authority bell/completion cases
  (parked tab, focused-pane suppression, kill switch off). SSH parity is
  exercised manually per the SSH test procedure before each slice ships.

## Cut-Offs (shipped as four stacked slices)

1. **Shared tracker in main.** Extract the processor core to shared, run the
   per-PTY tracker in `onPtyData` replacing `extractLastOscTitle`, parity
   tests. Main-internal consumers only; no IPC or renderer change.
2. **Authority flip.** `pty:sideEffect` channel, renderer store handler,
   titles/bell/tracker authority to main for local+SSH behind the kill
   switch; parked watcher stops byte parsing for those kinds.
3. **Inversion unwind.** Synthetic frames into the tracker, off `pty:data`;
   OSC 133;D and PR-link facts; mobile `lastTitle` source preference.
4. **Long tail.** Command Code scrape to main, sidecar OSC 9999 dedup, parked
   watcher shrunk to fact-driven mode (deletion waits on kill-switch
   retirement), Phase 4 delivery-interest registration documented in the gate
   design.

## Open Items

- **Daemon checkpoint `lastTitle` is write-only.** The daemon sleep/periodic
  checkpoint (`daemon-pty-adapter.checkpointSessions` → daemon
  `Session.getSnapshot`) persists the daemon emulator's `lastTitle`, which is
  derived from real PTY bytes only — synthetic hook title frames never reach
  the daemon process, so that field cannot carry hook-driven titles. Today no
  restore path reads it back (`ColdRestoreInfo` drops it; reattach snapshots
  surface only the ANSI payload), so there is nothing to fix. Main-side
  consumers of the renderer serializer's `lastTitle` (mobile snapshot reads
  and the headless hydration seed) prefer main's tracked title. If a future
  consumer starts reading checkpoint `lastTitle`, it must route through the
  same tracked-title preference.
- **Kill-switch retirement.** Once `terminalMainSideEffectAuthority` is
  removed, the parked watcher's byte-parser mode, the renderer transport
  parsers for local/SSH, and the legacy synthetic-frame `pty:data` copy all
  become dead code and the watcher byte path can be deleted outright.
