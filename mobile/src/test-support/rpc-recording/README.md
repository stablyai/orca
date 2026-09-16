# Main RPC recordings

Test infrastructure only. `pilot-scenarios.json` binds logical operations/actions to small
mount adapters, which live one module per domain under `adapters/` and are registered in
`adapters/mounted-operation-modules.ts`. The adapters execute the actual product modules from the
selected source root, using React's test renderer; they do not reconstruct acceptance or lifecycle
logic.
The module loader transpiles the real source with TypeScript and resolves task barrels
lazily so unused native views do not need a device. Accessing an unspecified native import
fails. The history metadata function is exposed to its adapter without rewriting its body.
JSX compiles through the automatic runtime, because product sources use it and never import React;
a classic `React.createElement` emit throws `React is not defined` on the first screen render.

The transport reuses `createStableLogicalRpcClient`, `projectMobileRpcRequestParams`
(through that client), `RpcClientRequestTracker`, `RpcClientStreamRegistry`, and the
delivery-unknown marker. Hook mounting follows `use-mobile-native-chat-file-search.test.ts`;
physical session mounting follows `stable-logical-rpc-client.test.ts`. Neither test exported a
reusable mount utility.

A subscription is opened by the real registry, not by the runner: subscribe params, frame routing
and the unsubscribe wire (`buildReadyStreamUnsubscribe`) are all product code, and the only thing
the recorder adds is the wire id and the name it files the payload under. The registry is per
physical session, the way a `DirectRpcClient` owns one, so a frame is routed by the session that
published its subscribe rather than by whichever session is current — after a cutover those are
different registries, and the retiring one is what holds a cancelled subscribe long enough to
unsubscribe it once its id arrives. Whether the two registries are distinct objects is not
otherwise observable through a server subscription, because stream ids are unique across both.

## Mounting a screen

`screenMount` mounts a component rather than a hook, and `projectMountedScreen` reads back what it
rendered: the inert primitives it chose, the copy it put on them, the labels it gave them, and the
crash instead if a reply took it down. A screen that throws is a recording, not a suite failure —
several reply partitions do exactly that, and refusing to record them would leave the shapes that
break a screen the only ones this oracle cannot see. The boundary also reports the crash to the
effect sink, so a hook mount, whose projection is the hook's own value and never a crash, still
carries it into a golden: an effect forces a cleanup checkpoint even when no adapter looks.

The view packages a screen imports are in `screen-native-substitutes.ts`, under the table's usual
rule: only what a recording is known to read is listed, the rest throws. Every element there is
inert. It renders its children and keeps its props where a projection can read them, and does
nothing else: no callback it is handed is ever invoked, nothing is measured and no navigation
happens. `renderedElementProps` is the consequence — an inert list never calls `renderItem`, so the
data it was handed is the only record of what the screen would have drawn.
`screen-native-substitutes.test.ts` is the census; it renders every element with a callback prop and
a render callback as children and fails if either is called.

Nothing is listed ahead of a reader, and that is a rule rather than an oversight. A member
provisioned before any recording reads it converts a refusal that would have forced a decision into
a silent stand-in, and a silent stand-in is how an inert `InteractionManager` or `Alert` swallows the
send a screen deferred behind it. The table was cut back to the members a recording actually reads;
whoever mounts the next screen adds what it needs together with the recording that reads it.

## What a scenario declares about its device

Two device surfaces are backed by the scenario instead of refused: `deviceStore` backs
`@react-native-async-storage/async-storage`, and `deviceState.notificationTray` backs
`expo-notifications`. Undeclared, both stay exactly as they were — a throwing store and an unlisted
package — so no existing recording changes and no new one reaches a device by accident.

Reads resolve the declared entry or `null`, and never a write. A write that fed back into a read
would let a later read return a byte nothing declared, which is the device back inside the
recording; writes are recorded as effects instead, where they are observed rather than assumed.
That is the whole point of the declaration: every byte a read can return is visible in the scenario
file, and `scenarioSha256` pins it per golden like any other scenario field.

## Scenario actions

```json
{"action":"mount","id":"mount"}
{"action":"query","id":"old-query","args":{"query":"old"}}
{"advance":120}
{"complete":"files.searchPaths#1","params":{"worktree":"id:A","query":"old","limit":16},"reply":{"ok":false,"error":{"code":"method_not_found","message":"Unknown method"}}}
{"bind":"old-inventory","request":"files.list#1","params":{"worktree":"id:A"}}
{"checkpoint":"pending"}
{"action":"select","id":"select-b","args":{"workspace":"B"}}
{"action":"select","id":"reset-a","args":{"workspace":"A"}}
{"complete":"old-inventory","params":{"worktree":"id:A"},"reply":{"ok":true,"result":{"files":[]}}}
{"checkpoint":"stale-completed"}
{"frame":"runtime.clientEvents.subscribe#1","params":null,"reply":{"ok":true,"streaming":true,"result":{"type":"ready","subscriptionId":"sub-1"}}}
```

`{"$undefined":true}` in the input means explicit undefined, including an own property;
absence remains absence. Completion params are asserted against projected sender params.
Concurrent requests of one method require a logical binding and asserted params; random
wire ids never identify completions. Timers only advance explicitly, and zero-time drains
flush due timers, promise continuations, and React work after every step. Date, performance,
Math.random, Web Crypto random bytes/UUIDs, and transport ids are deterministic. React draws one
Math.random of its own the first time a process awaits `act`, and memoizes what it resolves, so the
scheduler pays that draw before it installs the seeded generator: every recording starts at the
same seeded value whether it runs alone or after another family.

A `frame` names the subscribe payload it arrives on — `<method>#<n>`, the same per-method
occurrence a request is named by — and carries a whole host response, which the real registry
routes. One step kind therefore covers `ready`, a data event, the host's `end` and a refusal, and
`params` asserts the subscribe params on every one of them, the contract `complete` already holds.
Ending a stream takes the two responses a host really sends: the `end` event as a streaming frame,
then the unary reply the dispatcher sends once the handler returns, which is what closes the stream
and which the registry reports to the listener as an error. A streaming frame arriving after that
is accepted and observes nothing, because the opener path answers for an id it no longer holds; a
non-streaming one names the scenario that has stopped matching.

A listener that throws on a frame is recorded as a `stream-listener-crash` effect rather than
failing the suite, the same rule the crash boundary holds for a screen and the unhandled-rejection
window holds for a detached effect. Only three listeners check the payload is an object before
reading its `type` — the two `runtime.clientEvents` ones and the structured agent session's, which
guards with `isSubscribeEvent` in `use-mobile-structured-agent-state.ts` — so without this every
other subscribing family died on the matrix's `result-absent` and `result-null` partitions — the
two shapes a stream listener is most likely to be wrong about were the only ones the oracle could
not record. The scenario's own faults
stay loud: a missing subscribe payload, a params mismatch and a closed stream are all raised before
or after the listener runs, and none of them is caught.

### Recorded time

Every settlement carries `startedAt` and `settledAt` in virtual milliseconds since the pinned epoch,
so the projection has a temporal dimension instead of relying on where a checkpoint happens to sit.
Any transition the product schedules for itself is recorded at the time it actually fires: change a
request deadline or the search debounce by any amount, in either direction, and a recorded number
moves. Granularity is exact milliseconds, because the fake timers fire at their scheduled time and
never coalesce; `recording-runner.test.ts` pins a 5 ms deadline settling at exactly `settledAt: 5`.

A checkpoint's own clock is not recorded. It is always the sum of the scripted `advance` steps, so
it is a function of the scenario rather than of the code under test; `run-recording.ts` asserts that
equality at every checkpoint instead, which costs no bytes and fails loudly if it ever drifts.

Recorded time covers thresholds the product schedules for itself. It cannot cover a threshold the
product only consults when something else makes it act, because no observation exists unless a
scenario acts inside the window. The `Date.now()` cache TTL in `use-host-repo-metadata.ts` is the
one such case here, so `settings-repo-cache-expiry` probes the cache at 59 s as well as at 60 s;
without the earlier probe a 20 s TTL and a 60 s TTL are both expired at 60 s and record identically.
That probe is coverage, not a substitute for recorded time: it bounds how small a TTL reduction is
visible, it does not make the reduction itself observable.

## Golden schema

Each file records `runnerVersion`, `baseline`, `lockfileSha256` (mobile's lockfile),
`recorderSha256`, `adapterSha256`, `scenarioSha256`, `platform`, `scenarioVersion`,
`projectionVersion`, `goldenFormatVersion`, `operation`, `family`, and `namedDeltas`. `platform`
and `lockfileSha256` are provenance and are not compared: a dependency or OS that changes
behaviour changes the trace itself, so comparing them would only fail candidates on unrelated
bumps. The rest are pinned.

`recorderSha256` covers every non-markdown file under this directory **except `adapters/`**, so the
engine that produced a golden is as pinned as the product baseline: editing the runner, the
transport, the projection or a fixture fails candidate mode on the header of every golden and
forces a deliberate re-record of all of them.

`adapterSha256` covers the source of the mount adapter module _that golden_ was recorded through —
the file under `adapters/` that mounts each operation its scenarios drive, read off the same
`mounts` calls that build the table the recording runs against, so the pin cannot name a file the
runner did not use. Adding a domain's module re-digests nothing that was already recorded, and
editing one fails exactly the goldens mounted through it. The adapters used to sit in
`recorderSha256` with the engine, which made every golden's header a function of every other
family's adapter: #20568 added two task modules and put a conflict on that one line in 153 files,
against every domain branch in flight.

`mutants/` is excluded for a different reason: nothing there is pinned by anything. A file that
cannot change a recording is not provenance for one, and pinning it would claim a provenance the
golden does not have — while charging every domain that adds a mutant a re-record of all 153
files.
The mutant table, the per-family mutant registry, the reference states and the suites that apply
them all live there. What makes the exclusion sound is that no recording can reach them: the loader
takes a resolved mutation spec instead of importing a table by name.
`mutants/mutant-seam.test.ts` is the check, and it proves reachability forward, walking the static
import graph from the two recording drivers and failing if any module under `mutants/` appears in
it. Naming the directory is rejected too, in either spelling, for the paths a module can be read by
rather than imported; `MUTANT_DIRECTORY` is not exported for the same reason. A path assembled at
runtime from fragments would defeat both, which is the seam's remaining edge.

For the same reason `recorderSha256` pins only the suites in `recording-drivers.ts`. A golden's
bytes come from `pilot-recordings.test.ts` or `family-recordings.test.ts` and from what they
import; a suite that reads goldens, or writes one to a scratch directory, puts no observation in a
recorded file. `scripts/rpc-recording.mts` records exactly that list, so the two cannot drift apart.

A module-private product export an adapter drives is exposed by its own module — see
`settingsMountExposures` — not by a shared table, because the exposure text does change what a
recording loads. Each domain module gets its own loader carrying its own exposures, and one
recording mounts one adapter, so `adapterSha256` pins exactly the exposures that reached it.

One exposure is shared instead, and pays for it: five domains mount a screen that reads the client
off the context `client-context.tsx` keeps module-private, and each used to carry its own copy of
`exports.recorderHostClientContext = Ctx;`. That string names a local no type checker follows, so
five spellings were five independent ways to reach a `ReferenceError` seconds into a recording.
`hostClientContextExposure` is the one copy; the trade is that it sits inside `recorderSha256`, so
editing it re-records all 727 goldens rather than the five families. A rename of the local is still
invisible to `tsc` — nothing short of editing the product module makes a private local checkable —
so `adapter-seam.test.ts` asserts the declaration it names exists exactly once, and refuses a sixth
inline copy.

The adapter seam is the directory, not a filename convention, because a convention is a rule nobody
enforces. `adapter-seam.test.ts` enforces this one: every file under `adapters/` is a registered
module, every registered module is declared in the file it is registered under, no adapter module
imports a sibling (which would leave a golden pinned to one module and driven by two), and
`pilotMountAdapters` mounts nothing of its own — an adapter defined in an engine file would be
pinned by `recorderSha256` on all 153 goldens instead of by `adapterSha256` on its own.

`scenarioSha256` covers the scenario input _that golden_ was recorded from — one manifest scenario
for a pilot golden, the generated variants and any hoisted prelude for a matrix or schedule golden,
canonicalised by `captureValue` so an explicit-undefined param stays distinct from an absent one.
Editing a scenario still fails candidate mode on the header, but only for the goldens derived from
it. The manifest used to be an input to `recorderSha256` instead, which made every golden's header
a function of every other family's scenarios: adding one domain's family re-digested all 153 files
and put a conflict on that line in every domain branch in flight. Which goldens a manifest derives
lives in `derived-goldens.ts`, so the digest is a function of the same derivation that records the
file rather than of a restatement of it; `golden-header-digest.test.ts` pins what both separations
buy.

Checkpoints contain ordered sender calls and serialized physical application payloads, action and
request settlements, projected state, and ordered external effects. Each sender call, each payload
and each effect carries `ordinal`, its position in one monotonic counter the recording shares
across all three lists (`write-ordinal.ts`), stamped at the moment that entry is written: the three
are independent append-only lists, so without a shared ordinal a send reordered ahead of a device
write, or ahead of a subscribe, moves no list and no golden notices. A subscribe is the sharper case
of the two, because it publishes synchronously while a request first waits for connected: swapping
`client.subscribe` and the first `sendRequest` in `use-live-worktree-name.ts` leaves the payload
order byte-identical and moves only the ordinals.
Scheduling the journal write in `codex-reset-attempt-journal.ts` on a timer instead of awaiting it
moved none of the 520 goldens before the ordinal existed and moves two now,
`codex-reset-credit-consumed` and its reply matrix. A request takes its ordinal at the logical
`sendRequest` call, not when the physical payload is published, so the two stamps differ whenever
the send waited for connected. What the ordinal cannot see is a defer shorter than the product's own
await chain: dropping that `await`, or deferring the write by one microtask, still lands it before
the send, because resolving the journal's promise chain costs more microtask ticks than the defer
saved.

`ordinal` replaced `sent`, a count of the requests sent at write time. A request count orders
payloads and effects against sends, never against each other, so it saw nothing at all in a family
that sends no requests: `host-worktree-refresh` sends none, every `sent` in its goldens was `0`
across all eight checkpoints, and moving that file's two initial snapshot reads from after
`client.subscribe` to before it moved no golden. Under the shared ordinal the same reorder fails
five — the family's own golden and its four matrix variants. Sender args have three
positional slots; absent, undefined and null are distinct `$rpc` tags. Literal objects containing
`$rpc` are escaped. Only object keys are sorted; array/effect order, options, budgets, settlement
times and errors stay observable. Errors contain category, message and `isRpcDeliveryUnknown`, never
stack paths, plus `code` and a recursively captured `cause` when the thrown error carries them.
Platform is provenance; candidate comparison does not require the same operating system.

Format version 4 added `scenarioSha256` and version 5 adds `adapterSha256`. A stale golden would
already fail this reader's byte compare, so each bump buys the diagnosis rather than the rejection:
`readGolden` names the stale format and says to re-record, instead of reporting an opaque
`(encoding)` difference. Neither bump moved an observation.

### Value pool

Format version 3 stores each distinct observation _entry_ once under `values`, keyed by the first
12 hex of sha256 over the entry's sorted-key, whitespace-free JSON. `golden-value-pool.ts` declares
how each field interns rather than sniffing it from the value: `sender`, `payloads` and `effects`
are lists of pool hashes, `settlements` is a map from action id to a pool hash, and `state` is one
hash. A field recorded in a container its declaration does not name fails, so a projection change
cannot silently flip a field's encoding. Files stay pretty-printed; compact printing and recursive
interning of nested sub-values were measured and rejected.

Version 2 pooled each field _whole_, which stored the shared prefix of these append-only histories
once per checkpoint — and once per reply partition in a matrix golden. Interning per entry is a
pure re-encoding: the resolved `Recording` is unchanged, which is why the version bump moved no
observation. Over the 153 goldens it is 5.35 MB → 2.78 MB raw, and the pathological family
(`hostedReview.create-intent`, 12 sites over a 12-request chain) 2.0 MB → 792 KB.

It also makes a real diff smaller rather than larger, which is the opposite of what version 2's
note predicted. Adding a `timeoutMs` to the first `git.status` of the create-intent chain — an
early request every downstream checkpoint re-states — touches the same 16 files either way, but
under version 2 that is ±17,100 lines and 1.03 MB of diff, and under version 3 ±3,764 lines and
0.20 MB, because a moved entry no longer rewrites every field value that contains it.

`readGolden` refuses any other `goldenFormatVersion`, checks that every pooled entry hashes to its
own key and that no entry sits in the pool unreferenced — content addressing is what keeps an entry
shared across checkpoints honest, and an unread entry would be content in the file that nothing
compares. It then resolves hashes back to values, and `compareGolden` reports the scenario, the
checkpoint id, the field, the JSON path inside it, and both resolved values.

### Prelude checkpoints

A generated variant declares the index where its distinguishing input lands. Checkpoints before
that index observe steps identical to the base, so `hoistPreludeCheckpoints` records them once in
a `<base>.prelude` scenario and starts each variant at its own divergence; it asserts each
variant's pre-divergence prefix matches the base. Reply matrices, interruption schedules and
lifecycle schedules use it. Checkpoints that merely happen to be equal are never merged: reaching
the same state through different inputs is evidence. Sibling schedules already drop their shared
prefix, so they are unchanged.

Nothing about a shared prelude is unverified. The `.prelude` scenario's checkpoints live in the same
golden as the variants that start after them, and `compareGolden` walks every checkpoint in the
file, so changing the prelude fails the golden it belongs to. The value pool does not weaken that:
it is per-file and content-addressed, so a prelude entry a later checkpoint re-states is stored once
and any change to it moves the hash in every checkpoint that reads it.

Family matrices and schedule recordings retain both boundaries. Matrices execute
raw reply partitions at the scripted sender port; they do not claim malformed-frame coverage
through direct/relay frame validation. Caches
are tested by follow-up requests; no private cache maps are inspected.

Every family runs the eleven partitions in `reply-matrix.ts` at **every reply its base scenario
scripts**, one golden per site, and nothing is crossed against consumed fields. A frame is a reply
too, so a subscription's `ready` and each event it carries are sites like any completion — named by
payload and occurrence, because one subscribe carries many frames and the name alone repeats. Nine
of the eleven partitions apply at a frame: the two transport rejections are the shapes a _request
promise_ fails with, and a subscription holds no promise for them to fail. Every success shape is
stamped `streaming: true`, since that flag is what routes a response to the open stream rather than
to a retired request id — without it `normal` would be a different shape from the frame
it replays, and no longer a control. Until frames were sites, `reply-matrix.ts` read only
`'complete' in step`, so a frame was never varied and a family that only subscribes threw
`No scripted reply to drive a matrix over`. The partitions are the reply shapes a host can send: a
normal result, an absent result, `null`, an inner `{ok: false}`
envelope with a string or object error, an inner envelope missing `ok`, an outer refusal with and
without a message, `method_not_found`, and a transport rejection with and without a message. Shapes
that were recorded before and are gone were unreachable: `successResponse` always sets `result`, so
JSON carries no explicit-undefined slot, and no mounted method's handler returns a number, a string,
an array, a bare `{}`, or a boolean. `null` stays because `linear.getIssue` returns it for a missing
issue and the b2 seed is a shipped null-result bug.

The message-less refusal and rejection are what separate the two failure paths a migrated call site
must keep apart: a refusal with no message falls back to the screen's copy, a transport drop with no
message surfaces its empty message verbatim. With only the message-carrying shapes both produce the
same text, so collapsing the two catches is invisible. Every source-control family used to carry a
hand-written `*-empty-message` scenario for exactly that; the partition carries it now.

### Which request a matrix drives

All of them. Selecting one per family was a hardcoded prefix list, and it silently `continue`d past
any family it did not name — ten of twenty-three, every family the source-control migration added,
which is why that migration's mutation evidence came down to single hand-written scenarios.
`replyMatrixSites` takes every completion step in the family's base scenario instead: no judgement
about which request is the "real" one, and no edit when a domain is added. A family that scripts no
reply at all throws, and a repeated request name throws, because the divergence would be ambiguous.

A variant answers its own site differently, so the replies scripted after it may never be asked
for. Those steps are marked `optional` and are answered only if the request is outstanding; the
sender list in each checkpoint records which ones the operation actually sent.

The `normal` partition replays a result the family already records for that request — the first
fulfilled reply in scenario order, base first — so no migrator invents a plausible payload per
domain. `null` and absent do not count, because each is already a partition of its own and
replaying one would leave the site with no success control. A site whose family records no other
success fails the suite until it is given a fulfilled scenario or a line in
`REPLY_MATRIX_NORMAL_RESULT_INVENTORY`, which carries the reply and the reason; an entry whose
family has since recorded a success fails too, so the list only shrinks. Four sites are on it: both
legs of the b3 seed, whose single scenario exists to record the defect; the b2 seed, whose only
recorded success is the shipped null result; and `settings.update`, a best-effort write whose reply
body no call site reads.

Detached unhandled rejections are captured as effects in a sequential process-scoped window,
with prior process listeners restored afterward. The known main bug it first recorded is fixed on
both legs: `new-workspace-runtime-context-null-results-degrade-to-absent` now records a null or
absent `settings.get` or `ui.get` result degrading the way a reply missing that member does, so
neither matrix golden carries a property-read TypeError effect any more. That leaves no golden
recording an unhandled rejection at all, so `unhandled-recording.test.ts` is what pins the capture:
without it a refactor could stop emitting the effect and every golden would still compare clean.
Task-model projections record setter invocations and resulting model values, not native UI.

## Commands and checker contract

Record only from unchanged pinned product sources and lockfile. The fence exempts only
`mobile/src/test-support/rpc-recording`, which `recorderSha256` and `adapterSha256` pin between
them; every other test-support path is compared against the baseline like product code:

```sh
ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test src/test-support/rpc-recording
```

Mutants are the defect evidence. `mutants/operation-mutations.ts` holds one anchored source edit
per adapter family, and every family's recording must change visible state when its mutant is
applied, which is what shows that family's `state()` projection observes the operation's real
output. Anchors are asserted to match exactly one site, because a repeated anchor would half-apply
while still counting as applied. Mutants replace the expression in memory, then run the same real
hook. `runRecordingMutant` accepts a mutated mounting adapter, scheduler, baseline and optional
observation projection, and returns `{verdict: "killed" | "survived", recording}`. Every mutant
test requires the mutation to apply exactly once and change visible state to count as killed.

Set `RPC_FOUNDATION_REFERENCE_ROOT` to an archived `bcba08b3e4` source tree to corroborate the
three B-seed mutants against the real defect; the reference checkout is never edited. Each seed
pins the archived tree's visible state, so a later refactor of those files cannot pass by merely
differing from main. Archived-tree corroboration for b1/b2/b3 is **unproven in CI**:
CI does not set `RPC_FOUNDATION_REFERENCE_ROOT`. These three checks remain opt-in; the
in-memory mutant checks run in CI. No archived-tree checks are registered for other
families because no reference states are defined for them.

## What this oracle does and does not see

It replays 368 manifest scenarios against frozen goldens and fails on any divergence: 727 goldens
over 888 tests, all inside `pnpm --dir mobile test`. Counts quoted further down are measurements of
the change they describe and are not restatements of this one. For a migration it answers one
question — does the rewritten call site produce the same sender calls, settlements, state and
effects as main did?

It is not a substitute for reading the diff. Five facts bound it, all learned the hard way:

- **It was blind to refusal ordering.** Reordering the settings and sibling refusal checks in
  `mobile-new-tab-agent-loader.ts` survives every golden except `probe-new-tab-both-refused` —
  measured by applying the reorder to the real source: 1 failure in 84 tests, and the one failure
  is a probe. Every pre-probe "refused" scenario refuses on the _first_ request, and every
  correlated-failure schedule rejects at the transport, where neither check is reached. A human
  reviewer caught that class by reading #20499.
- **It did not observe data loss on refresh.** No pre-probe golden records state after a refused
  _refresh_, so "does this screen keep its data or blank it?" was undocumented. This one is an
  observational gap, not a proven detection gap: publishing an unaccepted read in
  `use-new-workspace-runtime-context.ts` is caught by the refuse-after-data probe _and_ by
  `matrix-settings.workspace-context`, because a refusal from cold publishes `null` over a non-null
  initial value. Claim the recorded behaviour, not blindness.
- **It was blind to whatever the matrix skipped.** While the driven request came from a hardcoded
  prefix list, moving `readMobileHostedReviewGitStatus`'s `interpret` into the request chain — which
  turns a transport rejection into an `{ok: false}` result instead of letting it propagate — survived
  all 163 tests, because no scenario rejected `git.status` for that family. Driving every scripted
  reply kills it on five matrix goldens. The lesson is about the skip, not about that call site: a
  generator that opts a family out without failing is indistinguishable from coverage.
- **It was blind to a stream close with no frame behind it.** Deleting `unsubscribeStream()` from
  `mobile-notifications.ts`'s cleanup — the local close, not the `notifications.unsubscribe` RPC
  beside it — survived all 810 tests. Neither unsubscribe builder in `rpc-client-stream-registry.ts`
  knows `notifications.subscribe`, so closing that stream writes nothing to the wire: what the
  mutant leaks is a live subscription record, and the leak stayed invisible until a cutover replayed
  it. `notifications-desktop-stream-closed` stops the stream and then cuts over, where the leak
  becomes a second `notifications.subscribe` payload — one hand-written scenario per builder-less
  method, which is a rule nobody enforces. The teardown observation below closes the class: the same
  mutant now fails seven goldens rather than that one, and a family whose method does build an
  unsubscribe (`nativeChat.subscribe`, `runtime.clientEvents.subscribe`) is pinned by that payload
  at unmount as well.

- **It was blind to a guard whose empty arm no scenario declared.** Every session recording filled
  the cell its send is gated on — a measured viewport, a device token, a tab load that resolves — so
  dropping `viewportRef.current &&`, dropping the device-token conditional beside it in
  `use-mobile-session-terminal-stream-display.ts`, and dropping the `.catch(() => null)` on
  `ensureSessionTabs()` in `use-mobile-session-startup.ts` each survived the whole suite. The fix is
  scenarios that declare those cells empty, and the lesson generalises past them: a value an
  adapter holds as a constant is a cell no scenario can empty, so the arm that reads it empty is
  unreachable until the constant becomes a scenario argument. A stub may also reject where the
  product awaits it, on the scenario's instruction — that is declaration, not shaping, and it is the
  only way a refused scope callback is reachable at all.

  The terminal-create family is the same lesson read the other way round, and it cost three more
  holes. Its adapter pinned the active tab as a fixture, so the arm that omits `afterTabId` was one
  nothing could reach and sending `null` in its place survived; it dropped every launch option but
  the prompt and its two toasts, so swapping the `command` and `agentPrompt` members the host reads
  survived with those members never on the wire; and no scenario tapped twice, so dropping the
  in-flight guard survived. An argument the adapter supplies itself is not an
  argument. What the adapter forwards is the whole of what the goldens can hold.

`mutants/probe-hole-witness.test.ts` closes the first two and the last, and keeps them closed. It asserts the
hole and the closure together: each probe must kill its mutation _and_ every pre-probe scenario of
the same operation must still survive it. A probe that stops being load-bearing fails instead of
lingering.

What is still not covered: what the count-based raw-port inventory covers instead (which files
reach `sendRequest`, and how often), native storage, transport skew, and the mutations listed under
_Known-open holes_ below.

Which subscriptions are covered is no longer stated here. It is held as data in
`mobile/src/transport/rpc-subscription-inventory.ts`, where every product `client.subscribe` is
classified as recorded, an unwritten scenario, or walled with the wall named, and
`rpc-subscription-boundary.test.ts` fails on a new site, a stale entry, a wrong method and a
`recorded` entry naming a family this manifest does not have. This paragraph is why: it said nine
sites when there were ten — the count was taken over `mobile/src`, and the host screen's
`accounts.subscribe` lives under `app/`. A count in prose cannot fail. Today four of the ten are
recorded, two are unwritten scenarios and four are walled, and the list is what says so.

The frame plumbing is method-agnostic, so what stops a site is its consumer rather than the runner.
Blur is unrecorded across all ten subscribing sites: `useFocusEffect` is substituted as `useEffect`,
so a route's focus cleanup is recorded at unmount and an unsubscribe only a blur would reach is not
— driving focus needs a substitute, and no recording reads one yet. Four of the nine probes pin
behaviour with no demonstrated mutation — the two mixed reject/refusal new-tab orders
and the home-providers and resume-metadata refresh refusals; they are frozen observations, not
proven defect detectors. `settings.resume-metadata` projects `{}` as its state, so its probe
observes only sender calls and settlements.

### Recorded finding: a refused refresh is not handled the same way twice

The five refuse-after-data probes record a `settings.get` read refusing a _refresh_ after a
success: home providers and task hydration read through `settingsRead`, workspace context, resume
metadata and repo metadata through `optionalSettingsRead`. Which one a site uses does not change
what these probes record — the two share an acceptance and differ only in how they read a null
result, and a refusal never reaches the reader. Four call sites retain what they had.
`use-mobile-tasks-runtime-hydration.tsx` does not: it publishes `{}`, so a refused refresh wipes
the runtime task settings. That divergence is recorded, not repaired —
`settings-task-hydration-refuse-after-data.json` is the observation, and changing the behaviour is
a product change with its own re-record.

### Running it for a step-4 migration

```sh
# 1. Before touching the call site, confirm the oracle is green on your branch.
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test src/test-support/rpc-recording

# 2. Migrate the call site. Re-run. Any divergence is your diff, reported down to the JSON path.

# 3. If a divergence is intended, say so deliberately. Recording refuses to run unless the
#    product tree matches the pinned baseline, so bump `baseline` in pilot-scenarios.json to the
#    commit you are recording from first.
ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 \
  pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record
```

A call site that subscribes runs the same recipe, with one thing to check before step 2. The
subscribe payload is named `<method>#<n>` by per-method occurrence, and every `frame` step in the
scenario names it — so a migration that moves the subscribe past another send of the same method
renames it and the scenario no longer resolves. That is a loud failure, not a silent one
(`Missing subscription payload`), but it is the first thing to read when a subscription scenario
stops matching.

A re-record is a claim about behaviour. State the cause in the commit; every golden the refresh
moves should have one.

### Recording a behaviour change

A change that moves what a screen observes cannot be recorded from main's pin: the fence compares
the working tree against `baseline`, so the migrated source has to be what `baseline` names. Do not
record into a scratch directory and copy the moved files back — that leaves those goldens pinned to
a tree that does not produce them, which is the one claim this header exists to make.

1. Land the product change first, so every fenced path (`mobile/src`, `src/shared`,
   `mobile/pnpm-lock.yaml`) is final and committed.
2. Repin `baseline` in `pilot-scenarios.json` to that commit on your own branch. Nothing else: not
   main, not a tree you have not committed. The manifest is outside the fenced paths, so the repin
   may sit uncommitted while you record. After merging main the pin is the merge commit, since that
   is the last commit to touch a fenced path and the only tree the fence can match.
3. Re-record everything, not a subset, with the `--record` command above. The repin rewrites the
   `baseline` header of every golden, so every file moves and a partial refresh would leave the
   corpus pinned to two different trees.
4. Prove the delta by decoding the value pool of every golden against the branch point and sorting
   the files into four classes: header-only, body moved, added, deleted. The disclosed behaviour
   change is exactly the body-moved set; anything else in the last three classes is an unintended
   move to explain before committing. Know which header keys your own branch moves before you
   read the header-only class, or you will not recognise a clean result: the repin moves
   `baseline` on every golden, a branch that edited anything under `RECORDER_DIRECTORY` also moves
   `recorderSha256` on every golden, and a branch that edited one adapter module moves that
   family's `adapterSha256`. Any key outside that set is the finding. `scenarioSha256` hashes the
   derived scenarios rather than the manifest, so a repin alone never moves it.
5. Commit the repin and the refresh together, and state the cause.

After a squash-merge the pinned sha is unreachable from main, so the next recording on main repins
to main's tip in a follow-up — the same two-step #20563 and #20895 used. A reviewer checking an
in-flight branch resolves the pin against the branch, where it is a real commit.

Editing the recorder engine on a migration branch is the awkward case: `recorderSha256` moves, so
every golden needs rewriting, but the product tree no longer matches `baseline`, and bumping
`baseline` to the branch would record the migrated source and make the parity claim circular. Record
from the pinned commit instead, with this branch's recorder laid over it: `git worktree add
--detach <dir> <baseline>`, this tree's `rpc-recording/` and `pilot-scenarios.json` copied in,
`node_modules` symlinked, `RPC_FOUNDATION_GOLDENS` pointed at a scratch directory — then copy the
result back and run the candidate suite here. It must be a worktree, not a `git archive`
extraction: the fence runs `git diff --quiet <baseline>` and an untracked-file check, both of which
need a real `.git`, so an archive tree fails as `Product sources or lockfile differ from the pinned
main baseline` — a product mismatch that is not there. Format the recorder before recording: an
`oxfmt` pass afterwards moves `recorderSha256` again. A recorder-only branch that has merged main
is not the awkward case: its product tree is main's, so repin `baseline` to main's tip and record
in place — there is no migrated source for the goldens to be recorded against. That repin is the
whole of it, though. Where a branch is told not to repin, `--record` refuses on any product tree
that is not the pinned one, merged or not, and the detached-pin worktree above is the only recipe
that runs. Adding or editing
one domain's module under `adapters/` no longer needs any of this: only that domain's goldens move,
and they re-record from its own branch like any other behaviour change. Adding a mutant, a probe or
a suite that does not record needs none of it either, and moves no golden at all.

If your call site carries a mutation anchor in `mutants/operation-mutations.ts`, rewriting it will
make the anchor match zero sites. Re-anchor the same defect at its new home rather than deleting
the mutant: #20499 broke five anchors that way, and each one had a new home.

`live-probe/` holds the runtime companion: `mock-desktop-settings-reply-modes.patch` teaches the
mock desktop server to answer `settings.get` with a refusal, `method_not_found`, a null or absent
result, absent settings, or silence, and `settings-get-reply-probe.mts` drives a real socket
through the migrated acceptance layer. Opt-in, never applied by the suite, because the patch is a
product-tree edit.

## Known-open holes

Each entry below is a mutation no golden catches, confirmed by applying it to product source and
re-deriving the whole suite. None is reachable through the adapters as they stand, so closing one
needs new adapter capability or a call site that reads what it decides — not another scenario.
Anyone migrating these call sites should not assume the recordings will notice a change here. The
list is the count; a number in this paragraph would be one more thing that cannot fail.

- **`use-host-repo-metadata.ts` cross-module cache write.** Deleting `setCachedRepos(...)` survives.
  `workspace.repositories` now mounts `useNewWorkspaceRepositories`, which is the consumer that
  reads that cache to open workspace creation without waiting, but no recording runs the metadata
  fetch and that consumer in the same mount, so the write still has no observer. Closing it needs
  one recording that does both, not another scenario for either.
- **`use-pr-bot-author-overrides.ts` client-identity guard.** Forcing
  `sourceClientRef.current !== client` to `false` survives. The adapter closes over one client
  object: `reset` changes only the refresh key, `cutover` migrates the same stable logical client,
  and remounting discards the old hook state. Closing it needs a same-mount client replacement.
- **`mobile-session-write-operations.ts` display-mode acceptance.** Swapping
  `terminalDisplayModeSet`'s `success-result-or-skip` for `require-result-or-throw-message` moves
  none of the fifteen goldens that reach it. This one is not an adapter limit but a call-site
  property: the toggle reads no verdict and its own `catch` swallows a throw either way, so no
  acceptance is observable there. The first caller that reads a verdict closes it. What the goldens
  do hold at that site is the method, the params and the viewport pair.
- **`use-mobile-session-startup.ts` attached-terminal guard.** Deleting
  `if (activeHandleRef.current) { return }` from the 1800 ms created-session timer survives. The
  startup adapter owns that ref and nothing a scenario can drive writes it between the mount and the
  timer, so the arm the guard exists for — a terminal that attached while the timer was pending —
  has no way to occur. In the product it does, and the mutant then sends a second `worktree.activate`
  for a session that is already live. Closing it needs an adapter that can attach a terminal
  mid-scenario.

The original settings slice coverage maps nine host-RPC callers in
`settings-recording-coverage.json`; device-preference entries are excluded by coordinator
instruction. Later manifest additions require new scenarios and remain uncovered until
those recordings land. This runner does not certify native storage or transport skew.

## Salvaged reads

A checked reader parses tolerantly: `salvagingArray` drops an element that does not parse rather
than failing the whole reply, and `salvagedOptional` drops a member that is present but malformed
rather than reading it as incompatible. `collectSalvageDrops` counts both and names their paths on
every decoded reply, and no product code reads the result — so which rows a reply lost was visible
nowhere, including here.

The recorder now reads it. `salvage-observation.ts` wraps `classifyRpcReply` on the mounted module,
which is the one seam every checked read passes through and the only one that knows which operation
the drop happened under, and records a non-empty report as a `reply-salvage` effect carrying the
operation, the method, the decoded variant, the dropped paths and the count. Nothing in the product
tree changes: the report was already being built and thrown away.

No golden carries one. All 19,384 checked reads in the corpus decode their reply whole, on every
reply partition — the matrix varies the envelope a host sends, not the shape of a row inside a
result — so this observation pins the absence rather than a recorded drop. What it buys is the
next tightening: an element or member schema narrowed so a recorded row stops parsing moves the
golden even where nothing downstream reads the row. `salvage-observation.test.ts` is what keeps the
observation itself honest, driving a malformed row and a malformed optional through the real
`git.status` reply schema, because a refactor that stopped reporting would otherwise leave every
golden comparing clean.

## The cleanup checkpoint

Teardown runs on the recorded path, not only in `finally`. Each checkpoint clones the effects
array, so a rejection or state write produced by `dispose()`, the transport teardown or the final
`scheduler.flush()` used to land after the recording was built and never reached a golden — and an
unmount leak is exactly what this oracle exists to catch.

When teardown observes anything, it becomes a checkpoint with id `cleanup`. `state` is captured
before dispose, because the operation is gone afterwards.

Five goldens carry one today, covering six scenarios whose dropped observations were not noise:
`projectRowDetailError`, `projectMutating`, `hostLabelById`, `hostPlatform`, `workspaceAgent`,
`workspaceAgentOverridden`, `creatingKey`, `selectedAgent`, `agentOverridden` and `error`. A
scenario that stops leaking loses its checkpoint, which is a visible golden diff rather than a
silent improvement.

### Streams still registered at teardown

Teardown also asks each session's `RpcClientStreamRegistry` what it still holds, after the product's
own cleanup has run and drained and before the transport disposes the registries, and records a
non-empty answer as a `streams-registered-at-teardown` effect. Each entry is the stream's method,
the subscribe payload it was opened on, and whether the registry has it marked cancelled. The set is
read off the registry's own map rather than mirrored from the subscribes and frames the recorder
watches go by: the leak this exists to catch is exactly a divergence between what the product
believes it closed and what the registry still holds, so a mirror would reproduce the product's
bookkeeping instead of observing it.

The drain before the read is part of the contract. A cleanup that closes its stream on a due 0ms
timer has not run when `dispose()` returns, so reading the set first made a deferred close
byte-identical to a stream nobody ever closed.

Why it is not enough to watch the wire: closing a stream only writes a frame when its method has an
unsubscribe builder, and `notifications.subscribe` has none. Deleting that cleanup's
`unsubscribeStream()` used to fail one golden, the cutover scenario written for it; it now fails
seven, and the next builder-less method needs no scenario of its own.

An empty set is not recorded, so the corpus stays quiet and a family that starts leaking gains a
checkpoint. Four goldens report a non-empty set today, and all four are the same non-leak: the two
`runtime.clientEvents.subscribe` matrices, on every partition whose subscribe reply is not a
well-formed `ready`. With no `subscriptionId` to unsubscribe with, `disposeServerSubscription` marks
the record cancelled and keeps it until the id arrives — the retention the per-session registry
paragraph above describes. `cancelled` is in the observation so those are legible as what they are:
a product cleanup that never ran records `cancelled: false`, and because the drain precedes the
read, a cleanup that deferred its close to a timer already due records nothing at all. `flush()`
only runs work due at the current virtual time, so a close parked on a later timer is still
registered at the read and records `cancelled: false` like any other.
