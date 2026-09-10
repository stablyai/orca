# Main RPC recordings

Test infrastructure only. `pilot-scenarios.json` binds logical operations/actions to small
mount adapters. The adapters execute the actual product modules from the selected source
root, using React's test renderer; they do not reconstruct acceptance or lifecycle logic.
The module loader transpiles the real source with TypeScript and resolves task barrels
lazily so unused native views do not need a device. Accessing an unspecified native import
fails. The history metadata function is exposed to its adapter without rewriting its body.

The transport reuses `createStableLogicalRpcClient`, `projectMobileRpcRequestParams`
(through that client), `RpcClientRequestTracker`, and the delivery-unknown marker. Hook
mounting follows `use-mobile-native-chat-file-search.test.ts`; physical session mounting
follows `stable-logical-rpc-client.test.ts`. Neither test exported a reusable mount utility.

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
```

`{"$undefined":true}` in the input means explicit undefined, including an own property;
absence remains absence. Completion params are asserted against projected sender params.
Concurrent requests of one method require a logical binding and asserted params; random
wire ids never identify completions. Timers only advance explicitly, and zero-time drains
flush due timers, promise continuations, and React work after every step. Date, performance,
Math.random, Web Crypto random bytes/UUIDs, and transport ids are deterministic.

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
`recorderSha256`, `platform`, `scenarioVersion`, `projectionVersion`, `goldenFormatVersion`,
`operation`, `family`, and `namedDeltas`. `platform` and `lockfileSha256` are provenance and are
not compared: a dependency or OS that changes behaviour changes the trace itself, so comparing
them would only fail candidates on unrelated bumps. The rest are pinned. `recorderSha256` covers every non-markdown file under
this directory plus `pilot-scenarios.json`, so the runner that produced a golden is as pinned as
the product baseline: editing an adapter projection, a fixture or a scenario fails candidate mode
on the header and forces a deliberate re-record. Checkpoints
contain ordered sender calls and serialized physical application payloads, action and request
settlements, projected state, and ordered external effects. Sender args have three positional
slots; absent, undefined and null are distinct `$rpc` tags. Literal objects containing `$rpc`
are escaped. Only object keys are sorted; array/effect order, options, budgets, settlement times
and errors stay observable. Errors contain category, message and `isRpcDeliveryUnknown`, never
stack paths, plus `code` and a recursively captured `cause` when the thrown error carries them.
Platform is provenance; candidate comparison does not require the same operating system.

### Value pool

Format version 2 stores each distinct observation field value once under `values`, keyed by the
first 12 hex of sha256 over the value's sorted-key, whitespace-free JSON. A checkpoint holds five
hashes (`sender`, `payloads`, `settlements`, `state`, `effects`). Files stay pretty-printed so a
diff is reviewable; compact printing, element-level interning of list fields and delta encoding
against the previous checkpoint were measured and rejected. `readGolden` refuses any other
`goldenFormatVersion`, resolves hashes back to values, and `compareGolden` reports the scenario,
the checkpoint id, the field, the JSON path inside it, and both resolved values.

### Prelude checkpoints

A generated variant declares the index where its distinguishing input lands. Checkpoints before
that index observe steps identical to the base, so `hoistPreludeCheckpoints` records them once in
a `<base>.prelude` scenario and starts each variant at its own divergence; it asserts each
variant's pre-divergence prefix matches the base. Reply matrices, interruption schedules and
lifecycle schedules use it. Checkpoints that merely happen to be equal are never merged: reaching
the same state through different inputs is evidence. Sibling schedules already drop their shared
prefix, so they are unchanged.

Family matrices and schedule recordings retain both boundaries. Matrices execute
raw reply partitions at the scripted sender port; they do not claim malformed-frame coverage
through direct/relay frame validation. Caches
are tested by follow-up requests; no private cache maps are inspected.

Each family runs the nine partitions in `reply-matrix.ts` once, and nothing is crossed against
consumed fields. The partitions are the reply shapes a host can send: a normal result, an absent
result, `null`, an inner `{ok: false}` envelope with a string or object error, an inner envelope
missing `ok`, an outer refusal, `method_not_found`, and a transport rejection. Shapes that were
recorded before and are gone were unreachable: `successResponse` always sets `result`, so JSON
carries no explicit-undefined slot, and no mounted method's handler returns a number, a string, an
array, a bare `{}`, or a boolean. `null` stays because `linear.getIssue` returns it for a missing
issue and the b2 seed is a shipped null-result bug.

Detached unhandled rejections are captured as effects in a sequential process-scoped window,
with prior process listeners restored afterward. This preserves the known main bug recorded
as `new-workspace-runtime-context-null-settings-typeerror`; it does not repair the effect.
Task-model projections record setter invocations and resulting model values, not native UI.

## Commands and checker contract

Record only from unchanged pinned product sources and lockfile. The fence exempts only
`mobile/src/test-support/rpc-recording`, which `recorderSha256` pins instead; every other
test-support path is compared against the baseline like product code:

```sh
ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test src/test-support/rpc-recording
```

Mutants are the defect evidence. `operation-mutations.ts` holds one anchored source edit per
adapter family, and every family's recording must change visible state when its mutant is applied,
which is what shows that family's `state()` projection observes the operation's real output.
Anchors are asserted to match exactly one site, because a repeated anchor would half-apply while
still counting as applied. Mutants replace the expression in memory, then run the same real hook.
`runRecordingMutant` accepts a mutated mounting adapter, scheduler, baseline and optional
observation projection, and returns `{verdict: "killed" | "survived", recording}`. Every mutant
test requires the mutation to apply exactly once and change visible state to count as killed.

Set `RPC_FOUNDATION_REFERENCE_ROOT` to an archived `bcba08b3e4` source tree to corroborate the
three B-seed mutants against the real defect; the reference checkout is never edited. Each seed
pins the archived tree's visible state, so a later refactor of those files cannot pass by merely
differing from main.

The original settings slice coverage maps nine host-RPC callers in
`settings-recording-coverage.json`; device-preference entries are excluded by coordinator
instruction. Later manifest additions require new scenarios and remain uncovered until
those recordings land. This runner does not certify native storage or transport skew.
