# Terminal Hidden View Parking

Status: Shipped — Phase 1 of the terminal model/view architecture, kill switch
`terminalHiddenViewParking` (default on). See
[`terminal-model-view-contract.md`](./terminal-model-view-contract.md) for the
invariants this design extends and the full phase list.

## Problem

Hidden terminal panes keep a full renderer xterm instance alive (buffer,
scrollback, DOM, addons). At many-worktree scale this is the dominant renderer
memory cost, and it forces every hidden byte through renderer-side write/skip
decisions. The main-process model (daemon + runtime headless emulators) already
ingests every byte and can serve restorable snapshots, so the renderer view for
a long-hidden pane is redundant state.

A previous attempt shipped and was reverted the same day. The post-mortem
finding: parking unmounted the pane component, which also tore down the
renderer's PTY byte parsers — and those parsers are the only source of bell
notifications, title-transition agent-complete notifications, and tab titles.
A parked worktree whose agent finished would never notify. This design keeps
those side effects alive while parked.

## Design

### Park policy (renderer)

A pure policy module decides which hidden terminal tabs may park:

- Cold-park hysteresis: a tab must be hidden for 30s before parking.
- Hot-retain working set: recently visible worktrees/tabs are retained
  (5 minutes, bounded count) so quick tab switches never pay a re-hydrate.
- Eligibility excludes: visible panes, hidden-measuring startup probes,
  activity-portal panes, tabs with pending startup commands or pending
  activation spawns, floating-panel tabs, and any tab whose PTY is not
  snapshot-backed (remote-runtime `remote:` PTYs and SSH PTYs are excluded).
- Kill switch: `settings.terminalHiddenViewParking === false` disables parking
  entirely.

### Park mechanics

Parking a tab unmounts its `TerminalPane` React subtree (the overlay layer
renders null for parked tabs). This is the same teardown that tab-group moves
already exercise: transports detach but the PTY session, daemon model, and tab
state all survive. The xterm instance, its buffers, DOM, and WebGL/addon
resources are released.

### Parked watcher (the piece the reverted attempt lacked)

While a tab is parked, a pane-less watcher
(`parked-terminal-byte-watcher.ts`) keeps the pane's side effects alive. Its
consumption mode is decided once at watcher start:

- **Main side-effect authority on (default):** the watcher is purely
  fact-driven — it registers exactly one `pty:sideEffect` fact consumer and
  parses no bytes. Titles, agent working/idle/exited transitions, BEL
  attention, and PR links arrive as main-tracker facts and drive the same
  policy callbacks a mounted pane uses. With the hidden-delivery gate also on,
  the watcher marks the PTY hidden so main stops renderer byte delivery
  entirely; the DECSET 2031 color-scheme subscribe arrives as main's
  `2031-subscribe` fact and the watcher replies out-of-band via
  `transport.sendInput`.
- **Kill switch off:** the watcher subscribes to raw bytes through the
  dispatcher sidecar mechanism (the same mechanism background agent launches
  use) and runs the transport-level byte parsers with no xterm — OSC 0/1/2
  titles (all-titles ordering, live-path normalization), the title-transition
  agent tracker (completion notification, prompt-cache timer), the OSC-aware
  stateful BEL detector, the GitHub PR link scan, and a dedicated DECSET 2031
  byte responder (`parked-terminal-mode2031-responder.ts`, whose
  `subscribeToPtyData` registration doubles as the delivery-interest signal).

The two modes drive one shared policy-callback block, so flipping the kill
switch never changes notification semantics. Main's synthetic
agent-title/permission frames feed the main tracker directly and arrive as
facts; the legacy synthetic `pty:data` copy exists only in kill-switch-off
mode.

Out of scope while parked: OSC 52 clipboard writes. Terminal queries inside
hidden-dropped chunks are answered by main's model responder
([`terminal-query-authority.md`](./terminal-query-authority.md)); in
kill-switch-off byte mode only the 2031 reply is answered and Command Code
output is not scraped, matching the pre-gate status quo.

### Reveal

Revealing a parked tab remounts the pane subtree and rides the existing
reattach path: fresh xterm via `openTerminal` (unicode provider activation
before any write), daemon model snapshot > relay replay > cold restore
precedence, replay-guarded so snapshot-embedded queries never answer, then
`POST_REPLAY_REATTACH_RESET` hygiene, fit, and PTY resize. The watcher is
disposed before the pane handlers re-register.

## Invariants

1. PTY reads never stop; parking only changes renderer-side view lifetime.
2. Bell, agent-completion, title, and PR-link side effects keep working while
   parked (watcher parity tests).
3. Reveal shows model-correct output (visual gates: hidden TUI restore, long
   table, rendering golden) and accepts input immediately.
4. Sleep/wake, pane close, and PTY restart while parked must not leak watchers
   or strand parked state.
5. Memory: parked tabs hold no xterm buffers; renderer memory scales with
   visible panes.

## Relation to later phases (all shipped)

Side-effect authority in main (Phase 3) replaced the watcher's byte parsing
with the `pty:sideEffect` fact consumer; the hidden-delivery gate (Phase 4)
stops hidden byte delivery in main, moving the parked 2031 reply from the
byte sidecar to the `2031-subscribe` fact; the model query responder
(Phase 5) answers queries in hidden-dropped chunks. The watcher's byte-parser
mode survives only behind the kill switches. Parking still excludes
remote-runtime and SSH PTYs (no local snapshot to restore from); the watcher
would return as a byte parser only if remote-runtime tabs — whose bytes never
transit local main — ever became parkable.
