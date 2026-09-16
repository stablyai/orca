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
Math.random, Web Crypto random bytes/UUIDs, and transport ids are deterministic.

A `frame` names the subscribe payload it arrives on — `<method>#<n>`, the same per-method
occurrence a request is named by — and carries a whole host response, which the real registry
routes. One step kind therefore covers `ready`, a data event, the host's `end` and a refusal, and
`params` asserts the subscribe params on every one of them, the contract `complete` already holds.
Ending a stream takes the two responses a host really sends: the `end` event as a streaming frame,
then the unary reply the dispatcher sends once the handler returns, which is what closes the stream
and which the registry reports to the listener as an error. A streaming frame arriving after that
is accepted and observes nothing, because the opener path answers for an id it no longer holds; a
non-streaming one names the scenario that has stopped matching.

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
request settlements, projected state, and ordered external effects. Each effect and each payload
also carries `sent`, the number of requests sent when it was recorded: sender, payloads and effects
are independent lists, so without it a send reordered ahead of a device write, or ahead of a
subscribe, moves no list and no golden notices. A subscribe is the sharper case of the two, because
it publishes synchronously while a request first waits for connected: swapping `client.subscribe`
and the first `sendRequest` in `use-live-worktree-name.ts` leaves the payload order byte-identical
and moves only `sent`, from 0 to 1.
Scheduling the journal write in `codex-reset-attempt-journal.ts` on a timer instead of awaiting it
moved none of the 520 goldens before `sent` existed and moves two now, `codex-reset-credit-consumed`
and its reply matrix, where the write's `sent` goes from 0 to 1. What `sent` cannot see is a defer
shorter than the product's own await chain: dropping that `await`, or deferring the write by one
microtask, still lands it before the send, because resolving the journal's promise chain costs more
microtask ticks than the defer saved. Sender args have three
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
promise_ fails with, and a subscription holds no promise for them to fail. The success shapes keep
the scripted frame's `streaming` flag, since that flag is what routes a response to the open stream
rather than to a retired request id — without it `normal` would be a different shape from the frame
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

It replays 330 manifest scenarios against frozen goldens and fails on any divergence: 650 goldens
over 757 tests, all inside `pnpm --dir mobile test`. Counts quoted further down are measurements of
the change they describe and are not restatements of this one. For a migration it answers one
question — does the rewritten call site produce the same sender calls, settlements, state and
effects as main did?

It is not a substitute for reading the diff. Three facts bound it, all learned the hard way:

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

`mutants/probe-hole-witness.test.ts` closes the first two and keeps them closed. It asserts the
hole and the closure together: each probe must kill its mutation _and_ every pre-probe scenario of
the same operation must still survive it. A probe that stops being load-bearing fails instead of
lingering.

What is still not covered: what the count-based raw-port inventory covers instead (which files
reach `sendRequest`, and how often), native storage, transport skew, and the two mutations under
_Known-open holes_ below. The `subscribe` / `sendUnsubscribe` ports are covered for
`runtime.clientEvents.subscribe` only — the two client-event families are the whole of it. Nine
product call sites call `client.subscribe`; those two are recorded and seven are not, and no golden
mentions any of their methods: `notifications.subscribe`, `agentSession.subscribe`,
`session.tabs.subscribe`, `nativeChat.subscribe`, `terminal.subscribe`, `browser.screencast` and
`accounts.subscribe`. The frame plumbing is method-agnostic, so what stops each of the seven is its
consumer, not the runner. `terminal.subscribe` and `browser.screencast` write to a webview terminal
ref this runner has no substitute for. `accounts.subscribe` sits behind a snapshot decoder
re-exported through a React Native screen module the loader cannot reach, the same wall the accounts
read has always been behind. The remaining four are unwritten scenarios, not walls. Blur is
unrecorded across all of them: `useFocusEffect` is substituted as `useEffect`, so a route's focus
cleanup is recorded at unmount and an unsubscribe only a blur would reach is not — driving focus
needs a substitute, and no recording reads one yet. Four of the nine
probes pin behaviour with no demonstrated mutation — the two mixed reject/refusal new-tab orders
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
in place — there is no migrated source for the goldens to be recorded against. Adding or editing
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

Two behavioural mutations are not caught by any golden. Both were confirmed by mutating product
source and re-deriving the whole suite; neither is reachable through the adapters as they stand,
so closing them needs new adapter capability rather than another scenario. Anyone migrating these
call sites should not assume the recordings will notice a change here:

- **`use-host-repo-metadata.ts` cross-module cache write.** Deleting `setCachedRepos(...)` survives.
  `workspace.repositories` now mounts `useNewWorkspaceRepositories`, which is the consumer that
  reads that cache to open workspace creation without waiting, but no recording runs the metadata
  fetch and that consumer in the same mount, so the write still has no observer. Closing it needs
  one recording that does both, not another scenario for either.
- **`use-pr-bot-author-overrides.ts` client-identity guard.** Forcing
  `sourceClientRef.current !== client` to `false` survives. The adapter closes over one client
  object: `reset` changes only the refresh key, `cutover` migrates the same stable logical client,
  and remounting discards the old hook state. Closing it needs a same-mount client replacement.

The original settings slice coverage maps nine host-RPC callers in
`settings-recording-coverage.json`; device-preference entries are excluded by coordinator
instruction. Later manifest additions require new scenarios and remain uncovered until
those recordings land. This runner does not certify native storage or transport skew.

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
