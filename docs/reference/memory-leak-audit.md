# Memory Leak Audit

Started: 2026-05-26 18:36 PDT

Objective: scan the entire Orca codebase for memory leaks, fix confirmed leaks, and keep durable coverage notes until the repository-wide scan is complete.

## Codebase Inventory

Tracked code files, from `git ls-files`:

| Bucket            | Files | Status                                      |
| ----------------- | ----: | ------------------------------------------- |
| `src/renderer`    |  1534 | Checked                                     |
| `src/main`        |   838 | Checked                                     |
| `src/shared`      |   220 | Checked                                     |
| `mobile/src`      |    94 | Checked                                     |
| `tests/e2e`       |    71 | Checked                                     |
| `src/relay`       |    65 | Checked                                     |
| `src/cli`         |    64 | Checked                                     |
| `config/scripts`  |    27 | Checked                                     |
| `mobile/app`      |    16 | Checked                                     |
| `other-code`      |    13 | Checked                                     |
| `mobile/packages` |    12 | Checked                                     |
| `native`          |     6 | Checked                                     |
| `src/preload`     |     6 | Checked by IPC subscription heuristic       |
| Total             |  2966 | Repository-wide risk-pattern scan completed |

## Scan Log

- 2026-05-26: Loaded `$memory-leak-audit` checklist and built an initial inventory from `git ls-files`.
- 2026-05-26: Ran a broad listener/timer/observer search across `src`, `mobile`, `tests`, and `config`.
- 2026-05-26: Ran a React `useEffect` cleanup heuristic over 1845 TS/TSX files. Manual follow-up identified one confirmed issue in `src/renderer/src/components/editor/PdfViewer.tsx`: `EventBus.on('scalechanging', ...)` had no matching `off`.
- 2026-05-26: Ran a preload IPC heuristic. `src/preload/index.ts` and `src/preload/runtime-environment-subscriptions.ts` had apparent cleanup for their `ipcRenderer.on` subscriptions.
- 2026-05-26: Ran an `ipcMain.on` cleanup heuristic over `src/main`. The only unpaired hit was `src/main/ipc/session.ts`, which is a process-lifetime registration via `registerSessionHandlers`.
- 2026-05-26: Manually reviewed main-process interval/service candidates. Confirmed `src/main/speech/stt-service.ts` retained a timed-out, terminated speech worker in service state until idle teardown.
- 2026-05-26: Ran a Promise/EventEmitter heuristic over main, relay, and CLI code. Confirmed `src/main/ssh/ssh-connection.ts` left ssh2 startup listeners attached after a successful long-lived connection.
- 2026-05-26: Confirmed `src/main/browser/cdp-ws-proxy.ts` retained its startup HTTP server `error` listener after successful bind.
- 2026-05-26: Continued Promise/EventEmitter follow-up in daemon startup paths. Confirmed startup listeners were retained after successful bind/readiness in `src/main/daemon/daemon-server.ts`, `src/main/daemon/daemon-init.ts`, and `src/main/daemon/production-launcher.ts`.
- 2026-05-26: Reviewed BrowserWindow/session listeners. Confirmed `src/main/window/attach-main-window-services.ts` stacked a persistent browser-session `will-download` listener on every main-window services attach.
- 2026-05-26: Reviewed browser-session profile lifecycle. Confirmed deleted isolated/imported profiles left partition policy callbacks/listeners and configured-partition bookkeeping behind in `src/main/browser/browser-session-registry.ts`.
- 2026-05-26: Reviewed mobile RPC subscriptions. Confirmed `mobile/src/notifications/mobile-notifications.ts` retained a local streaming callback when notification subscription cleanup ran before the desktop returned `ready`.
- 2026-05-26: Reviewed speech model extraction timers. Confirmed `src/main/speech/model-manager.ts` left the abort polling interval alive when extraction abort/timeout rejected before the child emitted `close` or `error`.
- 2026-05-26: Manually followed up renderer high-risk surfaces from the broad scan: pane manager, browser webviews, terminal pane lifecycle, editor integrations, sidebar/global document listeners, observers, and shared clocks. Remaining hits had cleanup, were process-lifetime globals, or were element-owned listeners that are collected with their DOM nodes.
- 2026-05-26: Manually followed up main-process long-lived services from the broad scan: runtime RPC, SSH services, speech worker/model manager, rate-limit polling, filesystem watchers, BrowserWindow-scoped IPC/listeners, browser-session handlers, daemon startup, and relay-backed flows.
- 2026-05-26: Checked mobile React Native subscriptions, WebView injected listeners, RPC subscription teardown, repeated polling intervals, and app/session screens. Confirmed one notifications subscription cleanup issue and no additional unpaired repeated-mount listener leaks.
- 2026-05-26: Checked `src/shared`, `src/relay`, `src/cli`, `config/scripts`, `tests/e2e`, `mobile/packages`, and native computer-use runtimes for listener/timer/socket/watch patterns. Follow-up found existing cleanup or process/test-lifetime ownership.

## Confirmed Fixes

- `src/renderer/src/components/editor/PdfViewer.tsx`: unregister the pdf.js `scalechanging` listener on cleanup to avoid retaining stale component state after repeated PDF opens.
- `src/main/speech/stt-service.ts`: when dictation stop times out, remove worker listeners, terminate the worker, and clear the warm-worker slot so later dictation cannot retain or reuse a dead worker.
- `src/main/ssh/ssh-connection.ts`: remove ssh2 startup `ready`/`error` listeners once the connection resolves or rejects; steady-state disconnect listeners remain scoped to the live connection.
- `src/main/browser/cdp-ws-proxy.ts`: remove the startup server `error` listener after the proxy binds so the resolved start promise closure is not retained for the proxy lifetime.
- `src/main/daemon/daemon-server.ts`: remove the startup server `error` listener after the daemon socket binds.
- `src/main/daemon/daemon-init.ts`: remove detached daemon child-process startup listeners after IPC readiness or startup failure.
- `src/main/daemon/production-launcher.ts`: remove detached daemon child-process startup listeners after IPC readiness or startup failure.
- `src/main/window/attach-main-window-services.ts`: replace the named persistent browser-session `will-download` handler before registering it so window re-attach cannot stack handlers.
- `src/main/browser/browser-session-registry.ts`: clear deleted profile partition permission/display-media callbacks, remove the download listener, and drop configured-partition bookkeeping.
- `mobile/src/notifications/mobile-notifications.ts`: always drop the local notification stream on cleanup, even if the desktop has not returned a subscription id yet.
- `src/main/speech/model-manager.ts`: clear extraction timeout/abort pollers and remove child listeners directly on abort/timeout rejection, instead of depending on a later child `close`.

## Validation

- Passed: `pnpm vitest run --config config/vitest.config.ts src/main/speech/stt-service.test.ts src/main/speech/model-manager.test.ts src/main/ssh/ssh-connection.test.ts src/main/browser/cdp-ws-proxy.test.ts src/main/daemon/daemon-server.test.ts src/main/daemon/production-launcher.test.ts src/main/daemon/daemon-init.test.ts src/main/window/attach-main-window-services.test.ts src/main/browser/browser-session-registry.test.ts src/main/browser/browser-session-registry.persistence.test.ts` (10 files, 128 tests).
- Passed: `pnpm run typecheck:node`.
- Passed: `pnpm run typecheck:web`.
- Passed: focused `pnpm exec oxlint` over changed TypeScript files.
- Passed after final import cleanup: `pnpm vitest run --config config/vitest.config.ts src/main/daemon/daemon-server.test.ts src/main/daemon/production-launcher.test.ts`.
- Passed: `git diff --check`.
- Attempted: `./node_modules/.bin/vitest run mobile/src/notifications/mobile-notifications.test.ts`; blocked in this workspace because mobile dependencies are not installed (`expo/tsconfig.base` cannot be resolved). The mobile test file is included for the mobile package test environment.

## Residual Risk

- This was a repository-wide static/manual memory-leak audit of listener, timer, observer, worker, socket, watcher, subscription, and resource-pool patterns. It does not replace heap-snapshot profiling under a long interactive session, but no further confirmed leaks were found in the scanned patterns.
