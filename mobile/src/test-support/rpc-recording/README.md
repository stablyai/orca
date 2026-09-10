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

## Golden schema

Each file pins `runnerVersion`, `baseline`, `lockfileSha256` (mobile's lockfile), `platform`,
`scenarioVersion`, `projectionVersion`, `goldenFormatVersion`, `operation`, `family`, and
`namedDeltas`. Checkpoints
contain ordered sender calls and serialized physical application payloads, action and request
settlements, projected state, and ordered external effects. Sender args have three positional
slots; absent, undefined and null are distinct `$rpc` tags. Literal objects containing `$rpc`
are escaped. Only object keys are sorted; array/effect order, options, budgets and errors stay
observable. Errors contain category, message and `isRpcDeliveryUnknown`, never stack paths.
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

Detached unhandled rejections are captured as effects in a sequential process-scoped window,
with prior process listeners restored afterward. This preserves the known main bug recorded
as `new-workspace-runtime-context-null-settings-typeerror`; it does not repair the effect.
Task-model projections record setter invocations and resulting model values, not native UI.

## Commands and checker contract

Record only from unchanged pinned product sources and lockfile:

```sh
ORCA_BACKGROUND_LAUNCH=1 RPC_FOUNDATION_RECORD=1 pnpm --dir mobile exec tsx scripts/rpc-recording.mts --record
ORCA_BACKGROUND_LAUNCH=1 pnpm --dir mobile test src/test-support/rpc-recording
```

`run-step1-exit.ts` exports `runStep1Exit({scenarios, goldens, determinismRuns, requireMutants})`.
The first two arguments are filesystem paths, `determinismRuns` is an integer >=2, and
`requireMutants` contains `acceptance`, `order`, and/or `race`. It runs candidate parity,
family matrices, schedules, deterministic repeat checks, and all three B-seed mutants in
Vitest through the cross-platform `runProcess` launcher. It forces candidate mode and
checks that golden file bytes did not change. It throws for invalid inputs or failing tests;
success returns `{ok:true, stdout, stderr, scenarios, mutants}`. It never writes goldens.
The checker is owned by lane A and was absent on this baseline.

Set `RPC_FOUNDATION_REFERENCE_ROOT` to an archived `bcba08b3e4` source tree to additionally
prove all three B-seeds differ in visible state from main; the reference checkout is never
edited. Mutants replace one asserted source expression in memory, then run the same real
hook. `runRecordingMutant` accepts a mutated mounting adapter, scheduler, baseline and optional
observation projection, and returns `{verdict: "killed" | "survived", recording}`. The B-seed
tests require the mutation to apply exactly once and change visible state to count as killed.

The original settings slice coverage maps nine host-RPC callers in
`settings-recording-coverage.json`; device-preference entries are excluded by coordinator
instruction. Later manifest additions require new scenarios and remain uncovered until
those recordings land. This runner does not certify native storage or transport skew.
