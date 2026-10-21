# Canceled cwd validation waiter lifetime

Canceled working-directory checks retained their AbortSignals while the shared native filesystem check remained pending. The change releases those caller references immediately while preserving the underlying native operation, raw-promise identity and callback ordering.

**A small promise reaction and empty holder still remain per canceled wait until native settlement.** JavaScript promise reactions cannot be removed. This correction releases the signal, listener and caller resolvers; it does not establish a total bound on waiting metadata or explain an incident's memory magnitude.

## Ownership and callers

`src/main/providers/working-directory-validation.ts` keeps one pending validation per exact cwd. The raw `fs.stat` cannot be aborted, so the map entry and any UNC semaphore slot must survive caller cancellation until real settlement. Retiring them early would permit duplicate native work on the same stalled path.

Previously each caller registered a `finally` callback that captured its signal. The fix keeps each caller's raw promise reaction in its original position, but that reaction now references a small holder. Abort or settlement removes the abort listener and clears the holder. A separate waiter factory prevents the first signal from sharing the map's cleanup closure. The redundant per-call rejection observer is removed; the existing map-level `then(forget, forget)` still handles native failure when every caller has left.

The sole production importer is `pty-subprocess/spawn-preflight.ts:127–136`, through `local-pty-utils.ts`. `daemon-terminal-admission.ts` supplies a preparation signal, and `pty-subprocess.ts` forwards it to preflight. Ordinary daemon requests use a 30-second client timeout and a 5-second cancellation guard. A caller can therefore finish while the native filesystem operation remains pending across later requests. Those request timers do not bound the raw stat duration.

No-signal callers still receive the exact original promise. Native map deletion, UNC lane ownership, WSL checks, creation reservations, shutdown and process authority are unchanged. The change stays on the execution host and applies to folder workspaces and git worktrees without a wire change.

## Why each raw reaction remains

Existing wait utilities were checked. A shared settlement observer changes this API's callback order: a raw-promise observer registered before a signal waiter can abort it before its raw result arrives. Moving every waiter behind an earlier shared observer would fulfill that waiter instead. The per-call holder preserves that order and synchronous cancellation. Six permanent regressions cover an external aborting observer before, between and after signal waiters, for native success and failure.

## Before/after evidence

The standalone proof bundles the actual validation module, UNC path parser and semaphore. Its native async stat is a deferred fixture; WSL subprocess operations throw if unexpectedly reached. It performs no actual cwd probe, remote filesystem access, native subprocess launch or app launch. The fixture contains 32 small canceled callers per outcome; no large payload is attached.

| Before raw native settlement    | Original Node 26.6.0 | Original Electron 43.7.0 / Node 24.21.0 | Fixed, both |
| ------------------------------- | -------------------- | --------------------------------------- | ----------- |
| Signals reachable               | 32                   | 32                                      | 0           |
| Cancellation errors reachable   | 0                    | 32                                      | 0           |
| Caller option objects reachable | 0                    | 0                                       | 0           |
| Native stat calls               | 1                    | 1                                       | 1           |

All measured caller objects collect after native settlement in both versions. Both native success and failure have the same lifetime result. Other controls pass on both runtimes:

- Later live waiters receive the original operation's success or actionable error, and their listeners are removed.
- An already-aborted first caller still leaves the raw operation owned; no-signal callers share the same raw promise.
- Three canceled callers on one UNC host leave two native slots occupied. The third native operation starts only after one real completion.
- Forty-eight actual-module settlement/abort schedules and six raw-observer ordering cases match the original.
- Native rejection after all callers cancel produces no unhandled rejection.
- Synthetic CRLF source and patch reads produce identical reversed/fixed source and hashes without product writes.

`sources.cjs` reverses `fix.patch` in memory and checks exact baseline and fixed SHA-256 values. Source hashes use canonical LF; reports include effective dependency and bundle hashes. No git history, ignored notes or copied production implementation is needed to rerun the proof. Each run has a 20-second deadline; the commands below set a 192 MiB heap limit.

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc --max-old-space-size=192 docs/audits/working-directory-wait-retention/reproduce.cjs
```

For Electron, run its installed executable with the same flags and script path, setting `ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1`. It runs in Node mode and creates no windows.

## Source compatibility and validation

The audited baseline module is byte-identical to main commit `291b4ddd6f1c1af480169885e0fda7f9c78ff053` and release `v1.4.198` (`e0826956fcfc532f5a1e55b5e081f2e57e553c43`). All nine recorded caller/dependency sources also match that main commit. This one-product-file change does not depend on the shared waiter helper or its auth-wait changes. `source-versions.json` records the exact comparisons; historical source equality is not a historical packaged-runtime reproduction.

The fixed three-file regression run passed 31 tests. Reversing only this fix gives one expected first-caller retention failure and 30 passing controls, including the six raw-observer cases:

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config docs/audits/working-directory-wait-retention/before.config.mjs src/main/providers/working-directory-validation-retention.test.ts src/main/providers/working-directory-validation.test.ts src/main/daemon/pty-subprocess-cwd-cancel-identity.test.ts
```

`validation.json` records verification results. The measured retention requires a still-pending native operation; no affected-host capture, byte slope or attribution to #19831 is claimed.
