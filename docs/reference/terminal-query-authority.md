# Terminal Query Authority

Status: Shipped — Phase 5 of the terminal model/view architecture, kill
switch `terminalModelQueryAuthority` (default on). Builds on
[`terminal-model-view-contract.md`](./terminal-model-view-contract.md) (this
phase **amends invariant 6**),
[`terminal-side-effect-authority.md`](./terminal-side-effect-authority.md)
(Phase 3), and the Phase-4 hidden-delivery gate
(`src/main/ipc/pty-hidden-delivery-gate.ts`).

## Problem

Phase 4 drops renderer-bound bytes for hidden-gated PTYs after model ingestion
(`src/main/ipc/pty.ts:1426,1515`, `src/main/ssh/ssh-relay-session.ts:931`).
Queries embedded in dropped bytes get no reply: DA1 (ConPTY 1.22+ blocks
waiting for it — `terminal-conpty-device-attributes.ts:22`), CPR probes hang
TUIs, OSC 10/11 leaves `claude /theme` blind while hidden. The pre-Phase-4
hidden skip latch had the same hole (only mode 2031 and the 10s codex startup
window answered), so this is not a regression — it is the long-standing gap
this phase closes.

Contract invariant 6 ("the model must never answer queries") was written
against a real bug: the daemon emulator replying ahead of the renderer with
default-xterm values (the OSC-11 default-black-background race,
`headless-emulator.ts:86-97`, pinned by `session.test.ts:163-190`). The danger
was never "the model answers" — it was **two answerers for the same bytes**,
one of them with wrong values. Phase 5 keeps the singularity and fixes the
values.

## Decision: the delivery decision is the reply decision

Main answers a query **iff main dropped the chunk that carried it**. The same
per-chunk hidden-gate predicate (`shouldDropHiddenRendererPtyData`) that
decides renderer delivery decides reply ownership, evaluated once,
synchronously, at ingestion:

- Visible/unmarked PTY → chunk delivered → renderer xterm auto-replies via
  `Terminal.onData` → `transport.sendInput`, unchanged.
- Hidden-marked, no delivery interest → chunk dropped → main answers from the
  runtime headless emulator, via the provider input path (`provider.write`,
  same path as `pty:write`; daemon shell-ready write gating and the SSH relay
  write apply unchanged).
- Replayed/seeded/snapshot bytes → answered by no one (replay guards on both
  sides).

This is structurally exactly-one-responder: a chunk is delivered or dropped,
never both, and each side only answers bytes it actually parsed live. The
mark/unmark ordering, unhide-before-restore, and restore-marker IPC all exist
from Phase 4 and are reused, not duplicated.

Rejected alternatives:

- **Fact-based renderer replies per query class** (the mode-2031 pattern
  generalized): needs a main-side detection grammar per query, a fact round
  trip per reply, and the renderer cannot answer CPR/DECRPM anyway — the
  emulator is the only state for a hidden pane. The 2031 fact stays because it
  is subscription registration, not a state query.
- **Emulator always answers**: re-creates the OSC-11 double-reply race for
  visible panes. Never.

## Mechanism: forwarded emulator onData, not a new grammar

`HeadlessEmulator` has `onData` wiring behind a per-write capture flag.
For static and model-state queries, xterm core **is** the query grammar: the
runtime emulator runs the same xterm version with equivalent options as the
renderer pane, so main's reply set equals the visible renderer's by
construction — verified empirically against the bundled headless build:
DA1/DA2, DSR 5n, CPR, DECRPM (including unknown-mode `0`), DECRQSS (including
DECSCUSR from cursor options), XTVERSION, kitty `CSI ? u` all reply; XTWINOPS
(`windowOptions` stays default-off) and XTGETTCAP stay silent, matching
visible behavior today. The headless build has **no theme service**: OSC
4/10/11/12 queries and DSR ?996n return nothing even with the `theme` option
set, so the view-attribute class is answered by responder-registered parser
handlers instead (below) — never by core defaults.

Forwarding predicate, captured per chunk in `OrcaRuntimeService.onPtyData` and
attached to the emulator `writeChain` link (the mark can flip between
ingestion and an async write; the decision must not be re-read at reply time):

1. gate enabled (`terminalMainSideEffectAuthority` and
   `terminalHiddenDeliveryGate` both on) AND new kill switch
   `terminalModelQueryAuthority !== false`;
2. the chunk was hidden-dropped for this PTY (`shouldDropHiddenRendererPtyData`
   — same module state, same tick as the drop sites);
3. the write is live PTY data — never `seedHeadlessTerminal`,
   `maybeHydrateHeadlessFromRenderer`, option pushes, or any snapshot replay
   (main-side replay guard, mirror of the renderer's `replay-guard.ts`);
4. no remote view subscriber is attached to the PTY (runtime terminal-RPC
   subscriber records / `mobileSubscribers`): a mobile/web/remote-desktop
   xterm receiving the multiplexed stream answers with view authority, exactly
   like a visible local pane. Legacy JSON `terminal.subscribe` streams **do**
   register as view subscribers and suppress, even when the consumer is a
   read-only watcher — deliberately conservative, because the stream may feed
   an older live xterm view and a withheld reply (the pre-Phase-5 status quo)
   is strictly safer than a double reply. Consumers that never register a
   stream (CLI `terminal.read`, automation observers) do not suppress — they
   also do not answer; that bounded no-reply case matches today's behavior.

Everything the emulator emits outside a forwarding window is discarded, which
also swallows unsolicited core emissions (e.g. native 997 color-scheme pushes
triggered by option mutations).

## Reply classes

| Class | Queries | Answer source |
| --- | --- | --- |
| Static | DA1 `CSI c` (ConPTY override below), DA2, DSR 5n, XTVERSION, DECRQM unknown → `0`, kitty `CSI ? u` | xterm core constants + kitty flag state |
| Model-state | CPR `6n`/`?6n`, DECRPM mode table (?1 ?6 ?7 ?25 mouse ?1004 ?1006 ?1016 ?1049 ?2004 ?2026, insert), DECRQSS DECSTBM/DECSCA/SGR, kitty flags | emulator buffer/mode state — for a hidden pane it is the only state, hence authoritative |
| View-attribute | OSC 4/10/11/12 `;?` queries, DSR ?996n | responder parser handlers + renderer attribute push (below); **silent until first push** |
| View-attribute (via options) | DECRQSS DECSCUSR, DECRQM 12 | xterm core, from pushed `cursorStyle`/`cursorBlink` emulator options |
| Silent | XTWINOPS, XTGETTCAP, ?15n/?25n/?26n/?53n | nobody, visible or hidden |
| Mode 2031 | DECSET 2031 subscribe | unchanged in Phase 5: main emits the `2031-subscribe` fact, the renderer replies (`handleHiddenMode2031SubscribeFact`, `pty-connection.ts`; parked watcher fact callback). Emulator-native 2031/997 output is suppressed by the forwarding guard |

### View-attribute bridge

Renderer→main push, `pty:terminalViewAttributes` — one global snapshot,
not per-PTY: the composed terminal `ITheme` (from
`applyTerminalAppearance`, `terminal-appearance.ts`),
`terminalCursorStyle`, `terminalCursorBlink`, and the resolved color-scheme
mode (`resolveTerminalColorSchemeMode` — the same source as the existing
hidden 2031 reply). Pushed on renderer startup and on every theme/settings
apply.

Main consumes it two ways:

- `cursorStyle`/`cursorBlink` are applied to every runtime emulator's options
  inside the replay guard; xterm core then answers DECRQSS DECSCUSR and
  DECRQM 12 with renderer-true values (verified working headless).
- Palette and color-scheme replies come from responder-registered parser
  handlers on the emulator (`registerOscHandler` 4/10/11/12,
  `registerCsiHandler` for DSR ?996n), because the headless core cannot
  answer them. The OSC handlers see SET payloads too, so runtime OSC
  4/10/11/12 mutations (and 104/110/111/112 resets) from the byte stream are
  tracked per PTY and layered over the pushed base palette — matching what
  the renderer's theme service reports for a visible pane.

Staleness rules: replies use the last push; a theme flip is stale for at most
one IPC hop (subscribed TUIs are corrected by the 2031/997 flip push).
**Before the first push main answers no view-attribute query** — a fabricated
default would resurrect the default-black OSC-11 bug; silence is the
documented hidden status quo.

### Kitty keyboard flags

`vtExtensions.kittyKeyboard: true` is enabled in `HeadlessEmulator`, matching
`buildDefaultTerminalOptions` (`pane-terminal-options.ts:50`). Risk is low:
for the write-only daemon use, keyboard state never alters serialization; the
change only makes the emulator parse `CSI =/>/< u` pushes instead of ignoring
them, and lets the responder answer `CSI ? u` with the flags the hidden app
actually pushed. Snapshot parity: add `kittyKeyboardFlags` to `TerminalModes`
for emulator re-seed parity only. `rehydrateSequences` must **not** push kitty
flags into a renderer xterm — `POST_REPLAY_REATTACH_RESET`'s deliberate kitty
reset (stale CSI-u Ctrl+C hazard, `terminal-replay-cursor-state.test.ts`)
stays authoritative. Slice 3 wires the re-seed consumer: the daemon
warm-reattach snapshot threads `modes.kittyKeyboardFlags` through the spawn
result into `seedHeadlessTerminal`, which applies them to the fresh runtime
emulator via its own `CSI = flags ; 1 u` parse (outside any forwarding
window), so hidden `CSI ? u` reports the flags the hidden app actually
pushed. Paths without a snapshot (cold restore spawns a fresh shell) answer
`?0u`; protocol-conformant programs re-push.

### ConPTY DA1 variant

The provider kind is known main-side: mirror `isLocalNativeWindowsPty`
(`windows-pty-compatibility.ts:59`) from the spawn record (local/daemon
provider, `win32`, not WSL). For such PTYs register a CSI `c` override on the
emulator parser (the main-side twin of
`installConptyDeviceAttributesHandler`) replying `CSI ?61;4c`, still gated by
the forwarding predicate. The override is installed at emulator creation and
retrofitted when the spawn mark lands (daemon stream data can create the
emulator before the awaited spawn response marks the PTY). ConPTY blocking on
a missing DA1 is a spawn-time hazard; the hidden-at-spawn loss window is
closed by the slice-3 `initiallyHidden` spawn flag (races section).

## Suppression: when main never replies

- Visible or unmarked PTY (chunk was delivered).
- Renderer delivery interest registered (chunk was delivered to a sidecar).
- Remote-runtime (`remote:`) PTYs — never markable
  (`isHiddenDeliveryGateManagedPty`), bytes never transit local main.
- Remote view subscriber attached (mobile/web/remote desktop owns replies).
- Seed/hydration/snapshot writes into the emulator, and option pushes.
- Kill switches off — no marks exist, and `terminalModelQueryAuthority` is an
  independent off switch for the responder alone.
- The **daemon** emulator: never, under any setting. The responder lives in
  main's runtime only; `session.test.ts:163-190` stays pinned verbatim.

## Transition races

Worst cases, per direction:

- **visible→hidden**: chunks delivered between the visibility flip and the
  mark landing in main are hidden-skipped by the renderer write path without
  query scanning. No reply, no duplicate — identical to the pre-Phase-4 hidden
  skip behavior, bounded by one renderer→main IPC hop. After the mark lands,
  main answers everything it drops.
- **hidden→visible**: unmark consumes the drop latch and emits the restore
  marker; the snapshot replay is replay-guarded, so queries main already
  answered are never re-answered from the snapshot; post-unmark live chunks
  are answered by xterm once (restore-queued live chunks reply late, not
  twice).
- **Split queries across the drop/deliver boundary**: neither parser saw the
  whole sequence → no reply; the restore marker resets renderer cross-chunk
  state and replay hygiene resets the parser. At-most-once holds.

Safe-side rule per class: duplicates are structurally impossible (one decision
point per chunk); where the race costs anything it costs a missing reply.
That is acceptable for state queries (DSR/CPR/DECRPM — TUIs re-probe or
tolerate silence, as they did for every hidden pane before this phase). The
one blocking-on-no-reply sequence, ConPTY DA1, only fires at spawn. A visible
pane answers it from the renderer xterm. A PTY spawned hidden previously had
no answerer until the renderer's hidden mark landed in main (one IPC hop
after spawn). Slice 3 closes that window with the `initiallyHidden`
spawn-record flag: the renderer declares hidden-at-spawn on `pty:spawn`
(never for remote-runtime transports), and main marks the PTY hidden before
the first byte — pre-spawn for
daemon-host sessions whose id is minted up front, immediately after
`provider.spawn` resolves otherwise — so the gate and responder own queries
from byte one. The pane's first visibility sync then re-marks or unmarks
through the existing Phase-4 machinery (unmark emits the restore marker for
any spawn-window drops).

## Invariants

1. Exactly one party may answer any query, chosen by the chunk's delivery
   decision: delivered → the consuming live view's xterm; dropped → main's
   model responder; replayed/seeded → no one. The decision is captured once,
   synchronously, at ingestion.
2. Main answers only from live PTY bytes parsed by the runtime emulator —
   never from snapshot, seed, hydration, or option-push writes.
3. View-attribute answers are renderer-true or absent: no reply is ever
   fabricated from emulator defaults (the OSC-11 lesson).
4. The daemon emulator stays write-only; daemon subprocess query writes stay
   zero (`session.test.ts` pins are permanent).
5. Reply parity is structural for static and model-state classes: same xterm
   core, equivalent options, no hand-rolled grammar — the only overrides are
   the documented ConPTY DA1 variant and the view-attribute parser handlers
   the headless core cannot serve.
6. Remote views keep view authority; main yields whenever a remote view
   subscriber is attached.

**Contract amendment** — `terminal-model-view-contract.md` invariant 6 is
replaced by:

> 6. Terminal query authority is singular and structural: the party that
>    writes a chunk into a live terminal answers its queries. Visible renderer
>    and remote views keep xterm authority. Chunks dropped by the
>    hidden-delivery gate are answered exactly once by the main model
>    responder, from runtime-emulator state plus renderer-pushed view
>    attributes. Replayed, seeded, or snapshot bytes are answered by no one.
>    The daemon emulator never answers.

The contract's test bullet "headless tracking does not answer DA, DSR, OSC 11,
or theme-sensitive queries" splits into: daemon emulator never answers
(unchanged pins) / runtime responder answers only hidden-dropped chunks. The
side-effect authority matrix row "DECSET 2031 reply — query authority stays
with the view (contract invariant 6)" gains a pointer here; its reply path is
otherwise untouched in this phase.

## Test strategy

- Responder unit tests beside `orca-runtime.test.ts`: marked vs unmarked vs
  interest-suppressed; each reply class; seed/hydrate silence; remote-
  subscriber suppression; ConPTY DA1 variant; kill-switch off; mark flip
  between ingestion and async emulator write (captured decision wins).
- Parity harness: shared query byte fixtures through a renderer-configured
  xterm (onData capture) and through the responder; assert byte-identical
  replies for static + model-state classes, and for view-attribute classes
  after an attribute push.
- `session.test.ts:163-190`: assertions stay; the comment is updated to name
  the main responder (not "the renderer") as the hidden answerer.
- E2E: hidden `claude /theme` reports the configured theme; hidden TUI
  blocked on CPR/DA unblocks while gated; reveal shows no stray reply
  fragments (`?1;2c`, `rgb:` …) on the prompt; Windows ConPTY golden and
  `terminal-hidden-view-parking.spec.ts` stay green.

## Cut-offs (shipped as three stacked slices)

1. **Responder core.** Emulator onData wiring + per-write capture + main
   replay guard; kitty flag enable (+ `TerminalModes.kittyKeyboardFlags`);
   static + model-state classes; ConPTY DA1 override; remote-subscriber
   suppression; `terminalModelQueryAuthority` switch; unit + parity tests.
   Main-only — no renderer change. Ships the DA1/CPR/DECRPM unblock.
2. **View-attribute bridge.** `pty:terminalViewAttributes` push, cursor
   option application under the guard, responder OSC/DSR parser handlers with
   per-PTY palette-mutation tracking, silent-until-push rule, `/theme` e2e.
3. **Contract alignment.** Invariant-6 amendment in the contract doc, test
   bullet split, `session.test.ts` comment, side-effect matrix pointer, and
   the Phase 6 prerequisites below recorded as accepted.

## Phase 6 (delete skip grammar + startup window): prerequisites from this design

Phase 6 is shipped: the renderer hidden-skip eligibility grammar and the 10s
codex startup renderer-query window are deleted. Kill-switch-off hidden panes
fall back to the pre-grammar path — hidden bytes ride the bounded background
scheduler queue; overflow latches the model-snapshot restore — and never run
a per-chunk content scan.

Accepted and shipped in slice 3 (except where noted):

- **Mark-before-first-byte** (shipped): panes spawned without a visible view
  are hidden-marked at spawn via the `initiallyHidden` flag on `pty:spawn`
  (spawn-record flag, not a renderer round trip) so startup queries —
  including ConPTY's blocking DA1 — are main-owned from byte zero. Phase 6
  removed the codex exclusion with the window: codex spawns are main-owned
  from byte zero too, the responder answering their startup probes.
- **Attributes before spawn** (shipped): the renderer pushes composed view
  attributes once at app start (right after settings load, before terminal
  reconnect/spawn), so spawn-time view-attribute queries no longer fall into
  the silent-until-push rule. Per-pane appearance applies keep re-publishing
  through the same deduped publisher.
- **Daemon shell-ready write gating** (verified): responder replies through
  `ptyController.write` → daemon `Session.write` are QUEUED pre-ready, never
  dropped, and the queue flushes at the shell-ready marker or the 15s
  `SHELL_READY_TIMEOUT_MS` bound (`session.ts`). The codex window was removed
  with hosted ConPTY golden coverage, unit DA1 parity, and the kill switches
  as the safety net; explicit spawn-time e2e on Windows daemon PTYs remains
  worth adding.
- With the skip grammar deleted, every chunk is either written to a live
  xterm or dropped — the delivered-but-skipped no-reply gap disappears and
  the only remaining loss window is the mark IPC race.
- **2031 consolidation** (optional follow-up): move the subscription registry
  into the responder (the headless core cannot serve 997 pushes any more than
  it can ?996n) and push 997 flips from the attribute cache, retiring the
  `2031-subscribe` fact reply, the parked responder, and the parked-tab
  theme-flip gap.
