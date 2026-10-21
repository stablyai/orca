# Completed RPC queue records remain reachable

Status: reproduced before and after the product fix on Node 26 and installed Electron 43.7.0 in Node mode.

`RuntimeRpcCallQueuePool` advances each lane's head without clearing the consumed array element. While any call keeps that selector active, completed records keep their `run`, `resolve`, `reject`, and signal fields reachable until that same lane compacts. Compaction requires more than 32 consumed entries and at least half the array consumed. Selector deletion also releases the arrays when every active and queued call finishes.

The fix assigns `undefined` to the consumed slot in `takeForeground` and `takeBackground` and permits undefined in the two array element types. An active call remains owned by its promise cleanup closure. Queued entries, both lane heads, counts, admission thresholds, batching, foreground preference, and cancellation behavior stay intact.

## Production reachability

- Desktop `src/main/ipc/runtime-environment-call-queue.ts` owns a module singleton. `runtime-environment-transport-routing.ts::callRuntimeEnvironment` passes a closure capturing request params, environment, and optional orchestration envelope. Its normal timeout is 15 seconds; `status.get` bypasses this queue.
- Paired web `src/renderer/src/web/preload-api/web-runtime-session.ts` owns another module singleton. `web-runtime-calls.ts` and `web-filesystem-api.ts::captureWebFileMutationSession` pass closures capturing params, environment, and sometimes an explicit client. Web request timeout defaults to 30 seconds after connection readiness.
- Current production callers pass/default `retainedBytes` to zero. The nonzero byte values in the proof exercise the queue's accounting; they are not evidence that deployed callers account their object graphs here.
- These are remote/paired execution paths. The finding does not explain local-only #19831 from code reachability alone.

Finite individual call duration does not guarantee that an old lane's consumed records disappear: overlapping calls in the other lane can keep the selector active. The extended proof completes 70 successive background calls while eight completed foreground payloads stay reachable before the fix; each background call finishes, and releasing the final call makes the selector idle and permits collection.

This is retention beyond useful lifetime, bounded in record count by existing compaction/admission behavior. It is not proof of unlimited growth for one selector or of any reported incident's magnitude. The isolated payloads are bounded dummy arrays rather than a real network workload.

## Proofs

`reproduce.cjs` bundles the actual queue module with its actual imports. `queue-source.cjs` reconstructs the baseline in memory by reversing `fix.patch`; both baseline and current source hashes must match `source-versions.json`. Eight completed calls capture eight 1 MiB typed-array payloads, with one other call holding the selector active. Weak references remain live before and all clear after the fix. Foreground and background lanes, eventual compaction, and eventual idle cleanup are covered. Queue byte credit and queued-call count already equal zero during stale retention. At most eight payload MiB are intentionally live in each fixture; the process has a 128 MiB old-space limit and a ten-second deadline.

`extended-controls.cjs` checks active payloads are retained until their call settles, cancellation releases queued payloads without waiting for unrelated active calls, synchronous failure releases only after compaction/idle before the fix, rolling cross-lane traffic, and a 140-call mixed burst with six cancellations. Both variants execute the same 134 remaining calls in FIFO lane order with foreground priority, then delete the idle selector.

`resolver-controls.cjs` isolates the runtime's settled-promise resolver behavior without using the queue. Keeping native resolve functions can also keep settled results reachable in some runtime versions; this must be reported separately from input closures.

Node and Electron results are stored separately. Node 26.6.0/V8 14.6 collects fresh response payloads even with the stale queue records. Installed Electron 43.7.0/Node 24.21.0/V8 15.0 retains all eight fresh response payloads before and releases them after the fix. The standalone resolver control reproduces the same difference: saving native resolve functions retains eight of eight payloads in Electron and zero in Node; releasing those functions permits collection in both. This control isolates runtime promise behavior without claiming all Electron versions or browser renderer modes behave identically.

The original Node-only negative-control expectation for response retention failed under Electron. The baseline now records that result rather than assuming every V8 version releases settled results identically. The fixed variant must release responses in both environments. This proof does not measure the exact Electron 43.4.1 historical binary.

Run from the worktree:

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=128 docs/audits/runtime-rpc-consumed-queue/reproduce.cjs
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=128 docs/audits/runtime-rpc-consumed-queue/extended-controls.cjs
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=128 docs/audits/runtime-rpc-consumed-queue/resolver-controls.cjs
ORCA_BACKGROUND_LAUNCH=1 node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/shared/runtime-rpc-call-queue.test.ts src/shared/runtime-rpc-call-queue-retention.test.ts
```

The installed Electron binary can run the same scripts with `ELECTRON_RUN_AS_NODE=1`, `ORCA_BACKGROUND_LAUNCH=1`, and the same Node flags. No Electron app or window is created. No network, microphone, or affected-host data is used. No heap-snapshot tools are exposed in this session; the proof measures WeakRef reachability and bounded process counters instead of reading raw heap snapshots.

The existing eight queue tests and six added retention/lifecycle tests pass with the fix. To reproduce the three retention failures against the reconstructed baseline, use `ORCA_BACKGROUND_LAUNCH=1 node --expose-gc node_modules/vitest/vitest.mjs run --config docs/audits/runtime-rpc-consumed-queue/baseline.config.mjs src/shared/runtime-rpc-call-queue.test.ts src/shared/runtime-rpc-call-queue-retention.test.ts`; the expected outcome is 11 passing tests and three failures, with exit code 1. Node and Web project typechecks and the changed-code quality gate passed during promotion. Explicit basic/type-aware lint also covers these otherwise ignored audit scripts.

## Source identity

The queue source before the fix, fetched `origin/main`, and `v1.4.198` all had SHA-256 `45921658a10ffeefe0247673227aab643d1b5251d24aa460244fadd5480fc349` at review. `source-versions.json` records exact baseline/current hashes and compared commit IDs. Availability in that release supports reachability analysis; it does not attribute an incident.
