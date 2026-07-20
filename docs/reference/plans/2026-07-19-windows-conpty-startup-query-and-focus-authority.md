# Windows ConPTY Startup Query and Focus Authority Design

Date: 2026-07-19

Status: Final decision; implementation pending

## Problem

On native Windows ConPTY sessions, a new agent can sometimes show terminal protocol bytes as user
text:

```text
]10;rgb:2e2e/3434/3434\]11;rgb:ffff/ffff/ffff\
```

An independent symptom can prefix user input with `[I`, the printable tail of the standard terminal
focus-in report `CSI I`.

The OSC text is an Orca-generated reply to the agent's OSC 10/11 foreground/background query. The
agent can issue that query before a daemon-backed `spawn()` resolves to the renderer, and waits only
about 100 ms for the answer. Orca therefore has a short-lived main-side startup responder in
addition to the normal renderer/model query authorities. On affected ConPTY timing, the reply sent
to the PTY is returned as cooked output with its ESC bytes removed. The current ingestion order
records that cooked echo in the authoritative runtime model before any renderer-bound filtering.

The focus symptom must not be treated as the same bug without evidence. ConPTY deliberately emits
DECSET 1004 (focus reporting) and DECSET 9001 (Win32 input mode) at startup. A direct native
PowerShell ConPTY capture consistently produced the bootstrap pair, while an injected `CSI I` was
consumed as a focus event and did not render as `[I`. The bootstrap is valid transport protocol;
the failure requires an additional agent, timing, input-mode, or replay condition.

## Root Cause

The startup OSC responder currently runs in Electron main only after runtime ingestion
([`pty.ts`](../../../src/main/ipc/pty.ts)). `LocalPtyProvider` calls the runtime before its public
data listeners ([`local-pty-provider.ts`](../../../src/main/providers/local-pty-provider.ts)), while
daemon `Session` advances sequence state, writes its emulator, persists pending output, and fans out
data before Electron main receives it ([`session.ts`](../../../src/main/daemon/session.ts)). A
renderer-only filter can therefore hide the symptom without removing it from the authoritative
model, daemon history, snapshots, or remote delivery.

The corrupted echo is timing-dependent but its ordering failure is deterministic: any sanitizer
downstream of an authoritative consumer is too late. The independent `[I` symptom has not yet met
that evidentiary bar, so this design fixes the proven OSC path and adds the real focus-path harness
without pre-approving a speculative focus workaround.

## Data Flow

```text
node-pty / remote relay PTY
  -> shell-ready marker scan
  -> source-owned serialized ingress transaction
       -> consume an early OSC query and write one canonical reply
       -> match or losslessly release the measured native-Windows echo projection
  -> authoritative emulator + persistence/history
  -> runtime side effects and mobile/remote stream
  -> renderer delivery or hidden-drop decision
  -> live terminal / snapshot restore
```

Raw sequence spans travel beside cleaned strings through every downstream hop. Empty transformed
spans advance sequence and flow-control state without writing bytes into an emulator or view.

## Rejected Prototype

The current working-tree prototype is not the implementation of this design:

- It removes ConPTY's leading `?1004h` in the renderer. This changes valid native-console focus
  semantics for every Windows PTY, including programs unrelated to agents.
- It filters OSC echo text only after runtime/model ingestion. The live pane can look clean while a
  hidden restore, reconnect, mobile view, or CLI snapshot still contains the garbage.
- Its echo state activates only after both color slots are answered. An echo of the first response
  can escape if it arrives before the second query.
- Its partial-match buffer can be lost on timeout, and its substring search can remove a later
  legitimate string that happens to equal a reply.

Implementation starts by removing the prototype's bootstrap output filter and renderer-only cooked
echo filtering. Existing unrelated Windows focus-idle safeguards remain.

## Existing Contracts Preserved

This design extends, rather than replaces:

- [`terminal-model-view-contract.md`](../terminal-model-view-contract.md), especially singular query
  authority, authoritative model restore, and raw sequence ordering;
- [`terminal-query-authority.md`](../terminal-query-authority.md), especially delivered-versus-
  hidden-dropped ownership and replay silence;
- [`terminal-side-effect-authority.md`](../terminal-side-effect-authority.md), especially parsing PTY
  bytes once in main before renderer delivery.

The startup responder is a bounded exception needed before normal delivered/dropped ownership can be
established. It must join the same ingestion decision, not operate as an unrelated renderer scrub.

## Decision 1: Source-Owned PTY Ingress Transaction

Sanitization must run on the host that owns the PTY, before that host mutates any authoritative
model or persistence. Electron main is too late for daemon sessions: `Session` has already advanced
its sequence, written its emulator, recorded pending output, and broadcast the data before main's
provider callback runs.

The transaction therefore has three installations of the same shared state machine:

- in `LocalPtyProvider`, before its configured runtime callback and data listeners;
- in daemon `Session`, before `outputSequence`, emulator writes, pending/checkpoint records, and
  attached-client fanout;
- in relay `PtyHandler`, before relay replay/history buffering and `pty.data` fanout. Main's
  `SshPtyProvider` is only an RPC proxy and never sanitizes relay output.

Electron main receives already-classified daemon data. A remote-runtime desktop client does not
reinterpret the stream; the remote Orca host owns its transaction. WSL sessions follow their actual
provider owner but never enable the native-Windows compatibility projection.

Fresh-session creation carries startup-transaction intent atomically. Daemon `createOrAttach`
receives the recognized-agent intent, execution-host kind, deadline, and validated renderer-pushed
color attributes. It first decides fresh versus reattach; only a fresh result constructs the
transaction before releasing the subprocess's already-buffered early output. A reattach discards
the intent without arming state. Cancellation, spawn failure, and teardown clear intent before any
PTY id can be reused.

Local creation installs the transaction before subscribing to node-pty output. Relay `pty.spawn`
carries the same fresh-session intent and installs it before releasing relay PTY output; relay
`pty.attach` never accepts it. If any owner cannot establish this ordering, the early responder is
not armed and normal query authority handles the query.

Increment `DAEMON_PROTOCOL_VERSION` for the new create/wire shape and add a named numeric-threshold
predicate in the daemon adapter/router. Current exact-version hello behavior remains; supported
legacy versions route through their existing adapters and fail the predicate. The SSH relay gets a
separate versioned spawn/data capability because daemon protocol support says nothing about relay
support.

An old daemon or relay keeps the legacy behavior and is never treated as having sanitized snapshots
or history. Main must not apply a second best-effort scrub to legacy output. New sessions receive
the invariant only after the owning daemon/relay is upgraded or restarted; an already-attached
legacy session remains explicitly outside it.

### Composition with shell-ready preprocessing

The ingress sequence domain begins after the existing shell-ready scanner. That scanner may hold
transport bytes and removes its private ready marker; marker bytes have never belonged to terminal
model or delivery sequence space and continue not to count. Its released non-marker bytes enter the
new ingress transaction in original order.

Snapshot and teardown barriers drain in pipeline order: the shell-ready scanner first releases its
non-marker buffer, then the ingress transaction resolves or abandons its candidate, then the model,
persistence, and views observe the resulting emissions. No later stage may introduce an unmetered
string transform.

### Raw sequence and emission contract

The state machine accepts source chunks with an explicit raw half-open range and returns zero or
more ordered emissions:

```ts
type PtyIngressSourceChunk = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
}

type PtyIngressEmission = {
  data: string
  rawStartSeq: number
  rawEndSeq: number
  transformed: boolean
}
```

The raw range is the post-shell-ready ingress sequence domain and remains contiguous even when
`data` is shorter after sanitization. The ordered emissions partition accepted source ranges without
overlap. Producer flow-control acknowledgement follows those emitted raw spans and is counted once
from `rawEndSeq - rawStartSeq`, never from emitted string length. A held prefix delays its ACK; the
buffer is strictly bounded and the serialized queue cannot acknowledge later output ahead of it.

The ingress raw high-water advances when a source chunk is accepted. Model-applied and
view-delivered high-waters advance only through ordered emissions, including empty transformed
emissions that consume a raw range. Runtime/mobile listener metadata carries
`rawLength = rawEndSeq - rawStartSeq`, not `data.length`. A restore that overlaps a transformed span
cannot slice cleaned text by raw offset and must request a fresh authoritative snapshot, matching
the existing `rawLength !== data.length` safety rule.

This metadata is end-to-end, not local to the state machine. Implementation changes the complete
path:

1. daemon `Session` or relay `PtyHandler` emission callback;
2. daemon/relay batching, coalescing, splitting, and wire notification;
3. daemon adapter or `SshPtyProvider` decode;
4. `OrcaRuntimeService` model and runtime/mobile listeners;
5. main renderer batching, pending/drop accounting, and preload payload;
6. renderer reconciliation and remote-runtime binary/live frame decoding.

The wire representation carries `data`, `seq = rawEndSeq`, `rawLength`, and `transformed`. A
span-only emission has empty `data` but non-zero `rawLength`; no layer may drop it before advancing
its high-water and producer ACK. It is not written to an emulator or xterm. Coalescing is permitted
only for contiguous spans and sums raw lengths independently of string lengths. A transformed
emission is indivisible because there is no byte-for-byte raw-to-clean offset; splitters must flush
it as its own frame or request snapshot reconciliation instead of slicing it.

If a snapshot is requested while a partial candidate is held, the transaction first abandons that
candidate and releases its bytes unchanged as an ordered emission. The authoritative emulator and
snapshot sequence therefore describe the same raw high-water.

### Serialization and teardown

Each PTY has a non-reentrant serialized ingress queue. A provider write may synchronously produce a
nested callback, but that callback is appended after the current source chunk rather than delivered
ahead of its remaining bytes. Timeout releases and snapshot barriers enter the same queue.

On exit, the queue releases all buffered bytes, applies those emissions to the authoritative model
and persistence, and fans them out before `onPtyExit`, `pty:exit`, or PTY state cleanup. Relay
disposal must flush both ingress prefixes and its existing pending output batches before clearing
them or killing PTYs, matching the natural-exit flush-before-`pty.exit` order. No drain may recreate
state after teardown. Ordinary chunks pass through as one unchanged emission.

## Decision 2: Startup OSC Queries Are Consumed Authoritatively

The early OSC 10/11 responder remains because removing it would regress daemon-hosted agent startup
and the agent's short color-query timeout. Its implementation moves into the source-owned ingress
transaction.

When registered for an agent spawn, it:

1. recognizes exact OSC 10/11 query grammar across provider chunks;
2. builds replies from validated renderer-pushed foreground/background attributes;
3. emits the canonical ST-terminated, 16-bit-channel reply used by renderer/model query authority,
   regardless of whether the query ended with BEL or ST;
4. records each reply transaction before writing it to the provider;
5. consumes the answered query from the authoritative model and view emissions so neither the
   hidden model nor a delivered renderer can answer it a second time;
6. begins echo recognition as soon as each individual reply is written.

If attributes or a provider are unavailable, the query is not consumed. It passes through unchanged
to normal query authority. A reattach never registers startup response state, matching current
behavior.

### Exact authority transfer

Startup query interception opens only for a fresh session whose atomic creation installed the
transaction before buffered output release. It closes at the first of:

- both OSC 10 and OSC 11 slots have been answered;
- the startup deadline expires;
- main sends an ordered authority-close control after either the consuming-view handshake or the
  hidden-runtime ownership mark is established;
- the spawn fails, is cancelled, reattaches, or exits.

Closing query interception does not discard already-written reply candidates. Echo recognition has
its own bounded lifetime and may finish or drain after normal authority takes over. A close and a
provider callback are ordered by the source owner's per-PTY ingress queue. Transport attachment to
a daemon/relay client is not a consuming-view signal. Main sends the close over a versioned control
method, and the source owner acknowledges the applied ingress sequence. Queries before that ordered
boundary are either consumed at source or removed from emissions; queries after it pass unchanged
to the normal delivered/hidden decision. Each query therefore belongs to exactly one authority.

The regular authority rules continue after the bounded startup window:

- delivered live bytes are answered by the live view;
- hidden-dropped live bytes are answered by the runtime model;
- replayed, seeded, and snapshot bytes are answered by nobody;
- the daemon's persistence emulator never writes replies.

Implementation must amend `terminal-model-view-contract.md` and `terminal-query-authority.md` to
name this source-owner startup authority, its opening/closing events, and its no-replay rule. It is a
real third responder class, not an undocumented exception.

## Decision 3: Matched Echo Suppression Is Lossless and Pre-Model

Only native Windows ConPTY agent spawns that pass the deterministic provider harness enable a
compatibility projection for replies written by the startup transaction. WSL and POSIX SSH PTYs do
not. A remote-runtime PTY can enable it only on its owning Windows host under the same evidence and
capability gate.

The harness records the exact projection ConPTY returns for the canonical ST reply, including its
chunking and any console transformation. The implementation must not assume that the projection is
always merely "remove ESC", and BEL or other reply forms are not added without separate evidence.
For every written reply, the transaction records that exact expected projection. Recognition is:

- FIFO in reply-write order;
- anchored at the next possible output position, not an unbounded substring search;
- active immediately for each reply instead of waiting for both color slots;
- bounded by the startup deadline and maximum reply length;
- streaming across chunk boundaries.

If incoming bytes diverge from the expected projection, all buffered bytes are released unchanged
and that candidate is abandoned. If the deadline expires or the PTY is cleared while a prefix is
buffered, the prefix is released through the serialized ingestion queue; it is never discarded. A
match advances the raw span but emits no bytes to the model, persistence, or views.

Projection matching cannot prove provenance. An application can print the same projected text at
the candidate position, causing a false-positive removal while the later real echo remains visible.
This is the central drawback of the workaround. It is accepted only if the real provider harness
shows a stable, immediate projection inside the narrow registered-agent startup window; otherwise
Orca disables the projection and keeps the visible output rather than risking deletion.

When the projection is enabled, the exact-collision behavior is explicit: the first identical
anchored candidate is removed and a later real echo is allowed through. The test fixture must assert
that result. This accepts a narrowly bounded false-positive risk instead of pretending provenance
is knowable; the release gate must document the observed timing window and justify that tradeoff.
Unknown, delayed, or interleaved transformations pass through visibly.

## Decision 4: Preserve ConPTY Focus Protocol

Orca must deliver the ConPTY bootstrap `?1004h`/`?9001h` to live terminal emulators unchanged. It
must not remove, reorder, or fabricate transport bootstrap modes.

The `[I` investigation gets a deterministic harness before a behavior change. The harness must
exercise the actual renderer focus callback and provider write path, not only inject `CSI I`
directly into node-pty. It records:

- raw provider output and its order;
- whether the focus report came from live ConPTY bootstrap state, an application-owned DECSET 1004,
  or replayed snapshot state;
- the exact bytes written to the provider;
- the exact bytes returned by the provider and stored in the model;
- agent lifecycle state when the report was emitted.

The implementation gate is strict:

- If stale snapshot modes cause the report, fix snapshot rehydration. Transport bootstrap focus mode
  is not persisted as application ownership.
- If a live agent receives transport focus before it owns terminal focus reporting, record that
  evidence without shipping a suppression heuristic from this document.
- If provider input/output transformation corrupts a correctly owned focus report, fix or sanitize
  that transformation at the same pre-model ingress boundary used for OSC replies.

No global `?1004h` filter ships under any outcome.

If the harness proves a focus-ownership race, a follow-up design is required before implementation.
That design must define the output-to-input ownership signal, distinguish xterm focus events from
identical typed/pasted/programmatic bytes, specify startup transitions and deadlines, define any
snapshot/wire metadata, and cover the separate explicit reattach-focus write path. This document
does not pre-approve an ownership state machine whose input provenance cannot yet be represented.

## Snapshot and Replay Rules

Interactive modes in a snapshot are capabilities of the live application, not proof that a new
view should emit input immediately.

- Cold restore into a fresh shell keeps the existing full mode reset.
- Reattach to a live agent may rehydrate application-owned focus mode, but never transport-only
  bootstrap ownership.
- Snapshot serialization/replay must not mutate live ownership trackers.
- A snapshot containing an OSC query or an old Orca reply never produces a provider write.
- Model and renderer snapshots must both be free of matched cooked reply projections.

Any future focus ownership metadata must be explicit; it cannot be inferred from serialized
`?1004h` text.

## Failure Policy

Safety is asymmetric:

- This design does not intentionally suppress a focus notification; evidence of a focus-ownership
  race triggers a follow-up design instead.
- Passing through an unrecognized OSC echo is safer than deleting output that may belong to the
  application.
- Missing a startup color reply falls back to the existing renderer/model authority. Duplicate
  replies are forbidden.
- Losing buffered output on timeout or teardown is forbidden.

## Cross-Platform and Remote Scope

- Native Windows local and daemon ConPTY: startup response plus evidence-gated echo compatibility
  path; focus investigation only until a proven root cause has its own complete design.
- WSL: normal Linux terminal semantics; no ConPTY echo or focus workaround.
- SSH: the same ingress/query ownership ordering, but no native Windows echo projection unless the
  remote host protocol later supplies explicit equivalent evidence.
- Remote runtime: the remote Orca host owns ingestion and must implement the same contract there;
  desktop local main does not reinterpret its stream.
- Mobile/web views: consume the sanitized authoritative model stream and retain exactly-one query
  response authority through the existing terminal-driver election.

## Edge Cases

- A query or echo split at any byte boundary, including OSC ST split across chunks.
- The first reply echo arriving before the second color query.
- Unrelated output, an exact application-text collision, or a partial match before the real echo.
- Timeout, snapshot, detach, process exit, daemon shutdown, or relay disposal while bytes are held.
- A provider write causing a synchronous nested output callback.
- Fresh spawn versus reattach, cancellation, PTY-id reuse, and an authority-close control racing
  with output.
- BEL-terminated queries still receiving the canonical ST reply.
- Empty transformed spans crossing coalescing, splitting, ACK, mobile, and remote-runtime layers.
- Old daemon/relay protocol versions and sessions that survive an application upgrade.
- WSL or POSIX SSH running from a Windows desktop without inheriting local ConPTY workarounds.
- Focus gained through normal terminal input versus the separate explicit reattach-focus write path.

## Test Plan

### Deterministic provider harness

- Capture the native ConPTY bootstrap across natural and forced chunk boundaries.
- Reproduce the OSC reply echo with the real provider and an agent query fixture.
- Exercise BEL and ST queries and assert the same canonical ST reply, plus separate OSC 10/11
  queries and combined OSC 10 `?;?`.
- Force the first reply echo before the second query.
- Split every byte boundary in query and echo fixtures.
- Print the expected projection immediately before the real echo and assert that the first
  identical candidate is removed while the later echo passes through.
- Exercise focus gain/loss through the actual xterm focus path.

### Ingress integration

- Assert local runtime ingestion and daemon emulator/pending/checkpoint persistence receive
  classified data before storing it.
- Assert renderer and mobile delivery receive the same visible output.
- Assert raw start/end spans advance by original provider length, producer ACK contribution is
  counted exactly once, and mobile/runtime metadata reports the raw span rather than string length.
- Assert a partial candidate is released unchanged on mismatch, timeout, snapshot barrier, move,
  and teardown, including a prefix held from an earlier callback.
- Assert re-entrant provider callbacks remain ordered behind the source chunk that caused the
  write.
- Assert restore overlap across a transformed or delayed span requests a fresh snapshot rather
  than slicing cleaned text.
- Assert `LocalPtyProvider`, daemon `Session`, and relay `PtyHandler` install the source-side seam;
  assert `SshPtyProvider` does not reinterpret relay data.
- Assert WSL, SSH, and remote-runtime streams do not enable the native-Windows projection.
- Assert a capable daemon sanitizes live output, snapshots, pending records, checkpoints, and cold
  restore; assert capable relay replay/history has the same property. Assert old daemon and relay
  versions are detected and never represented as sanitized.

### Authority and restore

- Assert an early-consumed query is answered once by its source owner and never by renderer or
  hidden model.
- Assert normal delivered/dropped query authority resumes after startup state clears.
- Assert the main snapshot, renderer snapshot, hidden reveal, reconnect, and mobile subscription do
  not contain cooked OSC text.
- Assert replay never sends OSC or focus replies.
- Assert ordinary native console focus behavior remains enabled.
- Assert the focus harness captures both terminal `onData` and explicit reattach-focus writes. Any
  later ownership implementation defines its tests in the required follow-up design.

### End-to-end acceptance

On native Windows, repeatedly create, hide, reveal, and reconnect new and resumed agent sessions.
Before typing, neither live output nor any restore path may contain `]10;rgb`/`]11;rgb`. Repeat the
focus/blur scenarios to classify `[I`; if it reproduces through an ownership race, this work stops
at the follow-up-design gate rather than claiming the symptom fixed. Application-owned focus
behavior must still move the TUI caret correctly after focus and reattach. Repeat with a plain
PowerShell terminal and a native focus-event consumer to prove no global regression.

Run renderer and main PTY suites, runtime snapshot/query suites, node/web typechecks, lint,
formatting, max-lines ratchet, reliability gates, and Electron validation. SSH ingestion changes also
require the repository's SSH end-to-end procedure.

## UI Quality Bar

This is not a layout, styling, or copy change. Existing terminal rendering and focus behavior must
look unchanged except that matched protocol garbage is absent. A passing terminal screenshot has a
clean prompt, no clipped or duplicated startup output, no restore flash, and the existing cursor and
focus presentation.

## Review Screenshots

1. A fresh native-Windows agent prompt after startup, with no OSC reply text.
2. The same session after hide/reveal restore, still clean and without duplicated output.
3. The session after focus, blur, and reconnect, showing the focus-harness outcome and prompt state.
4. A plain native PowerShell terminal after focus/blur, showing unchanged adjacent behavior.

## Rollout

1. **Correct seam and rollback.** Remove the prototype filters. Add the shared serialized ingress
   state machine, explicit raw-span emissions, and separate ACK accounting after shell-ready
   preprocessing. Install pass-through mode in `LocalPtyProvider`, daemon `Session`, and relay
   `PtyHandler` before their models, persistence/replay, and fanout.
2. **Protocol and authority contract.** Bump the daemon protocol, add relay capability/version gates,
   carry atomic fresh-spawn intent, define legacy fallback, and amend the canonical model/query
   authority documents with exact transfer events.
3. **Startup transaction.** Move OSC startup recognition/reply into source ingress, retain canonical
   ST replies, consume answered queries for model and views, and retain raw sequence accounting.
4. **Windows compatibility projection.** Gate the measured projection on provider evidence; add FIFO
   anchored recognition, serialized re-entrant delivery, lossless drains, false-positive coverage,
   and authoritative daemon/model/snapshot tests.
5. **Focus evidence.** Land the real focus-path harness. If it proves a focus-ownership race, stop
   for the required follow-up design; a direct snapshot or provider-transformation bug may be fixed
   only with a failing regression test that selects that branch.
6. **Electron and SSH gates.** Validate visible, hidden, restored, mobile-owned, native console, WSL,
   and SSH scenarios before removing the old startup implementation.

Each slice must keep query authority singular. The compatibility projection does not ship without a
model-snapshot assertion, and no focus behavior change ships before the deterministic focus harness
fails on the old behavior and passes on the new behavior.

## Lightweight Eng Review

- Scope: limited to the proven OSC startup corruption plus deterministic focus evidence. Global
  focus filtering and an unproven ownership state machine remain out of scope.
- Architecture/data flow: classification belongs at each PTY source owner after shell-ready
  preprocessing and before every authoritative model, persistence, replay, or delivery consumer.
- Failure modes covered: partial/mismatched projections, false-positive collision, nested writes,
  authority races, snapshot and teardown drains, protocol-version skew, reattach, and host
  isolation.
- Test coverage required: byte-boundary unit tests for the shared transaction; local, daemon, relay,
  runtime/mobile, restore, and legacy-protocol integration tests; real native-Windows provider and
  renderer-focus harnesses; Electron and SSH end-to-end validation.
- Performance/blast radius: ordinary output is a pass-through emission. Buffering is bounded by one
  startup reply candidate and its deadline. Protocol and sequence metadata touch every delivery
  path, so existing high-throughput, ACK, hidden-drop, and reconnect tests are mandatory.
- UI quality bar: terminal layout and styling are unchanged; only matched startup garbage
  disappears, without cursor/focus regressions or restore flashes.
- Required review screenshots: the four terminal states in `Review Screenshots`.
- Residual risks: the native projection may be too unstable to enable; exact projected application
  output can collide; `[I` may require a separately reviewed focus-ownership design.

## Non-Goals

- Replacing xterm's general query parser.
- Filtering arbitrary escape-looking terminal output.
- Disabling ConPTY focus or Win32 input mode globally.
- Changing WSL, SSH, or remote-runtime terminal semantics to imitate local Windows.
- Solving unrelated MCP startup warnings reported beside the terminal garbage.

## Final Invariants

1. Provider bytes are classified once before model ingestion and view delivery.
2. A live query has exactly one responder; replay has none.
3. Source-owner persistence, runtime/model state, and every view agree on removal of a matched
   startup-reply projection.
4. Raw provider sequence accounting survives sanitization.
5. Buffered unmatched output is always released; the sanitizer cannot silently lose user data.
6. ConPTY bootstrap modes reach live emulators unchanged.
7. No focus suppression ships from this design; a proven ownership race requires a follow-up design.
8. PTY teardown clears all startup-transaction buffers and focus-harness measurement state.
