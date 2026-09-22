# Closed browser dispatcher retains completed results behind pending native work

Before the fix, completed command results stayed in a closed browser dispatcher until its final handler settled. The fix releases settled cache records at close and drops newly settled records while closed. Pending native handlers, page authority, and executor teardown keep their existing lifetime.

## Actual paths and bounds

Source references in this section describe the hash-fenced baseline. `BrowserClientHostCommandDispatcher.dispatch` refuses every command once closed, before authority or duplicate lookup (`browser-client-host-command-dispatcher.ts:77–79`). `close` aborts active work and cancels queued work, but retains its pages and cached completed records when the join returns false (`:156–179`). `finishHandler` clears those owners only after the last native handler settles (`:268–272`). A newly settled cancellation record is also cached while a sibling remains active (`:297–302`).

`BrowserClientHostCommandResultCache.clear` drops only its record-to-page index. PageState.records and PageState.sequencesByCommandId also own the records; clearing just that index does not release result graphs. Existing `releasePage` uses exact settled-record eviction to remove both indexes (`browser-client-host-command-result-cache.ts:27–55`).

Defaults (`browser-client-host-command-state.ts:7–13`) are 256 pages, 256 active commands, 8 concurrent handlers, 32 queued/page, 64 cached results/page, 1,024 cached results total, and a 5,000 ms close/retirement join. Automation result schema allows at most 768 KiB of JSON-serialized value (`browser-client-automation-protocol.ts:5,89–99,116–131`). These are count/serialized-value limits, not a guaranteed heap/RSS size. The audit uses 32 tiny results, one native wait, and one canceled tiny queued input; it does not allocate near those maxima.

Production composition calls dispatcher close via `PairedRuntimeBrowserClientHost.closeHost` (`paired-runtime-browser-client-host.ts:165–180`). If close times out, actual `closeBrowserClientHostComposition` defers executor close behind `whenHandlersSettled` (`paired-runtime-browser-client-host-teardown.ts:37–56`). Keeping handler/page/native authority alive is intentional. Completed results cannot serve new or duplicate closed requests and need not share that lifetime.

## Ordinary handler time boundaries

- The navigation command checks cancellation before starting, then calls `routeWebContents.navigateGuest` (`browser-client-page-command-execution.ts:20–40`). The actual registry delegates to `navigateBrowserRouteGuest`, which awaits native `guest.loadURL` (`browser-route-guest-lifecycle.ts:99–123`) without adding a JS deadline or taking the AbortSignal. Native completion/rejection remains its settlement owner.
- Automation checks cancellation before execution, registers the exact guest, and forwards the signal into RPC (`browser-client-page-automation-runtime.ts:42–57`; startup `main-process-ready-runtime.ts:61–77`). Core handlers such as browser.snapshot destructure runtime and call its method without observing that signal (`runtime/rpc/methods/browser-core.ts:39–43`).
- The ordinary agent-browser helper execution has a 90-second default subprocess timeout (`agent-browser-bridge-types.ts:6`; `agent-browser-bridge-raw-process.ts:20–36`), with overrides for some operations. The agent-bridge embedded goto wrapper separately has a 30-second navigation timeout. Those deadlines are not a universal bound on all handler phases, and the direct route navigate path above does not use that wrapper.

The condition is a handler that outlives the dispatcher's five-second join. No affected-host occurrence, natural indefinite stall, or incident attribution has been established.

## Bounded actual-source proof

`scenario.test.mjs` uses the actual dispatcher, page executor, automation runtime, browser.snapshot RPC descriptor, native-navigation wrapper, and composition teardown function. Existing page-executor harness supplies renderer/session/route ports. The runtime's browserSnapshot/native loadURL are small controlled ports; no Electron window, OS child, real web request, or network is used. Logger/mock result arrays do not own the produced payloads: the automation output and dispatcher handler are plain functions, and each completed value is observed only through WeakRef after the helper returns.

Both Node 26.6 and Electron 43.7 / Node 24.21 pass all 4 cases before and after the two-file fix. A 15 ms join override keeps the proof bounded; the native port is explicitly resolved in finally and all native custody eventually settles.

| Observation                                                            | Before | Fixed |
| ---------------------------------------------------------------------- | -----: | ----: |
| Completed small payload objects alive after timed-out close            |     32 |     0 |
| Cached records after close (32 results + create + queued cancellation) |     34 |     0 |
| Canceled queued input still reachable                                  |    yes |    no |
| Running native handlers after close                                    |      1 |     1 |
| Page/executor and route/session custody retained                       |    yes |   yes |
| Close repeated before native settlement                                |  false | false |
| whenClosed pending before native settlement                            |    yes |   yes |
| Payload objects alive after explicit native settlement                 |      0 |     0 |
| First late cancellation cached while sibling remains pending           |      1 |     0 |

Open request replay preserves the exact same Promise and runs once. Closed duplicates fail with dispatcher_closed. Normal native resolution and rejection both complete the existing settlement path. Executor close and route/session release happen only after native settlement in both variants.

The initial candidate compatibility run passed 78 tests in 5 files, including its three lifecycle cases and existing dispatcher, page executor, paired-runtime composition, and paired-runtime host tests. The permanent retention suite adds two object-lifetime regressions: releasing completed results while native navigation stays pending, and releasing one late closed record while a sibling handler remains active. Final validation passed 77 tests across 5 production suites, Node typechecking, and all five explicit quality scans over product and artifact code. Reversing the patch produces the two expected lifetime failures while all 16 existing dispatcher tests pass. Commands and outcomes are recorded in `validation.json`.

## Fix scope

`fix.patch` changes only:

- `src/main/browser/browser-client-host-command-dispatcher.ts`: release each page's already-settled cache during close, after cancellation; discard newly settled records instead of caching them when closed.
- `src/main/browser/browser-client-host-command-result-cache.ts`: accept an optional `retain` flag in `record`, defaulting to the existing caching behavior. When false, existing identity-checked eviction drops the settled record before any cache admission.

Active/cancelling records, pages, native promises, abort behavior, join timing, FIFO, generation/authority checks, and the closed-settlement promise remain owned exactly as before. No row/byte cap changes. The host and executor continue waiting for their existing settlement owners.

## retirePage is separate

`selectCommandPage` rejects retiring and retired generations before `findExistingCommand` (`browser-client-host-command-page.ts:34–43`). Thus retired duplicate replay is already unavailable, even though the cache remains until forget/replacement. The control confirms that behavior and verifies explicit forget releases the cache and preserves the stale-generation floor. This fix leaves that existing retirement policy unchanged; freeing results on page retirement is a separate possible follow-up, especially while executor cleanup is still pending. Do not assume a live duplicate replay contract where the actual admission path rejects first.

## Reproduction and source fences

```sh
ORCA_BACKGROUND_LAUNCH=1 ORCA_BROWSER_CACHE_VARIANT=before pnpm exec vitest run --config docs/audits/browser-closed-result-retention/vitest.config.mjs docs/audits/browser-closed-result-retention/scenario.test.mjs
ORCA_BACKGROUND_LAUNCH=1 ORCA_BROWSER_CACHE_VARIANT=fixed pnpm exec vitest run --config docs/audits/browser-closed-result-retention/vitest.config.mjs docs/audits/browser-closed-result-retention/scenario.test.mjs
```

For Electron run the installed binary with `ELECTRON_RUN_AS_NODE=1` and `ORCA_BACKGROUND_LAUNCH=1`, passing node_modules/vitest/vitest.mjs and the same arguments. Reports are separate per runtime/variant; set `ORCA_BROWSER_CACHE_OUTPUT` to another file path to preserve captured reports. `sources.cjs` reverses `fix.patch` in memory and checks exact baseline/fixed hashes plus 21 caller/dependency hashes. The config loads those sources at their real production module IDs without changing checkout files. A synthetic CRLF control checks all 24 source/patch reads against canonical LF hashes. Both variants use the same controlled producer and lifecycle ports.

`source-versions.json` records 23 canonical-LF source/caller hashes. All 23 match named main checkpoint 291b4ddd6f1c1af480169885e0fda7f9c78ff053; 21 match v1.4.198. Both fixed source baselines match both named versions. The proof executes current source/dependencies, not a historical application binary.

## Permanent regression validation

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run --config config/vitest.config.ts src/main/browser/browser-client-host-command-retention.test.ts src/main/browser/browser-client-host-command-dispatcher.test.ts src/main/browser/browser-client-page-command-executor.test.ts src/main/browser/paired-runtime-browser-client-host-composition.test.ts src/main/browser/paired-runtime-browser-client-host.test.ts
ORCA_BACKGROUND_LAUNCH=1 ORCA_BROWSER_CACHE_VARIANT=before pnpm exec vitest run --config docs/audits/browser-closed-result-retention/vitest.config.mjs src/main/browser/browser-client-host-command-retention.test.ts src/main/browser/browser-client-host-command-dispatcher.test.ts
ORCA_BACKGROUND_LAUNCH=1 pnpm tc:node
```

The baseline regression command intentionally fails the two new lifetime assertions. The source and object counts prove a code mechanism, not incident-specific browser use, native stall duration, aggregate app RSS, or attribution to #19831.
