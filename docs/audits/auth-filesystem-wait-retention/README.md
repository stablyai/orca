# Release aborted shared auth filesystem waits

When a filesystem operation remains pending, later Codex/Kimi quota polls reuse it and wait with new deadlines. The old waiter uses `Promise.race` for every poll. On the installed Electron runtime, each abandoned race retains its rejection reason until the raw operation settles, despite removing its abort listener. The fix uses the existing `PromiseSettlementWaiters` registry, which attaches one raw-result reaction and removes expired waiters.

The original ownership symbols, last-waiter cancellation finalizer, one-raw-operation behavior, live callers, and future reads of a late result are preserved. Auth opts into deferred abort settlement so an already-queued raw result keeps its `Promise.race` priority; 24 success/failure/abort schedules compare equal before and after. Existing registry consumers keep their immediate-abort behavior. The abort factory type accepts `unknown` so false, zero, strings, and objects retain the existing auth rejection semantics. No admission or timeout limit changes.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=128 docs/audits/auth-filesystem-wait-retention/reproduce.cjs
```

For Electron, run the installed Electron executable with `ELECTRON_RUN_AS_NODE=1` and the same arguments/environment. This launches no window. The proof reconstructs the original sources by reversing `fix.patch`; expected baseline hashes in `source-versions.json` make source drift fail. Both versions run the actual production scheduler/waiter code, with only the raw filesystem operation replaced by one manually settled promise. A 15-second deadline fails stalled proof execution.

| Runtime / source                         | Plain aborted Errors alive while raw result pending | Amplified payload objects alive | After raw result settles | After owner drops |
| ---------------------------------------- | --------------------------------------------------- | ------------------------------- | ------------------------ | ----------------- |
| Node 26.6.0 / original                   | 1 of 128                                            | 1 of 128                        | 1                        | 0                 |
| Node 26.6.0 / fixed                      | 1 of 128                                            | 1 of 128                        | 1                        | 0                 |
| Electron 43.7.0, Node 24.21.0 / original | 128 of 128                                          | 128 of 128                      | 1                        | 0                 |
| Electron 43.7.0, Node 24.21.0 / fixed    | 1 of 128                                            | 1 of 128                        | 1                        | 0                 |

The one remaining reason belongs to the existing cancellation controller's first abort. Dropping the shared operation releases it. AbortController objects and abort listeners are released by both versions. The amplified arm attaches a **synthetic 64 KiB Uint8Array** to each Error, at most 8 MiB per case. Ordinary timeout errors are much smaller; the separate plain-Error arm verifies that artificial bytes are not needed to reproduce retention. Runtime differences are measured, without attributing them to a particular V8 change.

Controls check an already-aborted first caller never starting raw work, raw rejection identity, aborted caller identity, future callers receiving late and already-settled results, a live sibling surviving cancellation, arbitrary abort reasons, and removed listeners. The unit regression additionally checks that repeated expired waits add no raw-result reactions and that their plain Error objects are collectible while a live caller still needs the operation.

Validation: 50 auth/registry tests pass, including 18 new cases; the reverse-patch configuration produces two expected failures and 48 passes. Six existing watcher-consumer suites pass another 39 tests. Node, Web, and CLI typechecks, focused ordinary/type-aware lint, formatting, and the changed-code quality gate pass. `validation.json` records the test paths and scope. To run the prior implementation against the current tests, use `--config docs/audits/auth-filesystem-wait-retention/before.config.mjs` with those six auth/registry test paths.

## Scope and limits

The three production consumers are `codex-auth-presence.ts`, `codex-backend-auth.ts`, and `kimi-fetcher.ts`. Each intentionally retains the shared operation until actual filesystem settlement to avoid stacking native requests when UNC/WSL reads stall. This audit does not reproduce a real filesystem stall, historical Electron binary behavior, or an affected-host workload.

The auth source matches `v1.4.198` and the audited main revision; the existing registry also matches main. The earlier broad accumulator PR #10179, reverted by #10255, added path/waiter/admission limits to this module. This change instead removes abandoned wait reactions and introduces no such limits. Nothing here attributes #19831 or #19768 to this mechanism or claims an incident-scale memory slope.
