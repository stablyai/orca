# Memory Leak Audit Pass 2

Started: 2026-05-29 PDT

Branch: `nwparker/mem-leak-audit-pass-2`, based on latest `origin/main` after the first leak-fix PRs were merged. The held mobile notification PR #2887 is tracked separately and is not duplicated here.

Objective: re-scan the entire Orca codebase for missed listener, timer, observer, worker, socket, watcher, subscription, and disposable leaks; open scoped PRs for confirmed new misses.

## Codebase Inventory

Tracked code files, from `git ls-files`:

| Bucket            | Files | Status  |
| ----------------- | ----: | ------- |
| `src/renderer`    |  1575 | Checked |
| `src/main`        |   856 | Checked |
| `src/shared`      |   245 | Checked |
| `mobile/src`      |   100 | Checked |
| `tests/e2e`       |    72 | Checked |
| `src/relay`       |    65 | Checked |
| `src/cli`         |    65 | Checked |
| `config/scripts`  |    33 | Checked |
| `mobile/app`      |    16 | Checked |
| `mobile/packages` |    12 | Checked |
| `other-code`      |    10 | Checked |
| `native`          |     6 | Checked |
| `src/preload`     |     6 | Checked |
| Total             |  3061 | Checked |

## Scan Log

- 2026-05-29: Created fresh audit branch from latest `origin/main`; confirmed held mobile PR #2887 remains open and is not duplicated.
- 2026-05-29: Counted 3532 broad risk-pattern hits across `src`, `mobile`, `tests`, `config`, and `native`.
- 2026-05-29: Re-ran broad listener/timer/observer/worker heuristics after fixes. Remaining raw candidates are expected lifetime-bound listeners: React Native subscriptions with `.remove()`, WebView document-lifetime scripts, preload document-level file-drop handlers, pane DOM listeners whose pane elements are disposed, and singleton window focus cache invalidation.
- 2026-05-29: Checked React `useEffect`/`useLayoutEffect` candidates with risky APIs. Remaining hits are either direct cleanup returns, one-frame focus `requestAnimationFrame` calls, or effects whose teardown is handled by adjacent owner lifecycle.
- 2026-05-29: Checked main/runtime/browser/SSH/daemon/rate-limit/relay/shared/CLI/test/native buckets for unpaired timers, sockets, startup listeners, file watches, and abort listeners.
- 2026-05-29: Opened and merged low-risk follow-up PRs #3043, #3045, #3046, #3047, and #3049 for the confirmed misses.

## Findings

- `src/main/speech/model-manager.ts`: cancelling a stalled speech-model download only flipped an `aborted` flag; if HTTPS never delivered another chunk, the request and promise could stay alive indefinitely. Fixed by wiring `AbortController` through the download request and redirect chain. Risk: low. PR: #3043, merged.
- `src/main/runtime/rpc/unix-socket-transport.ts`: a long-poll request keepalive interval was only cleared on reply; if the Unix socket closed first and the handler never replied after abort, the interval retained the socket/request closure. Fixed by making connection close run per-dispatch cleanup. Risk: low. PR: #3045, merged.
- `src/relay/dispatcher.ts`: relay disposal stopped keepalives but did not abort in-flight request contexts, so stale SSH-side scans/watchers could continue after the dispatcher could no longer send responses. Fixed by aborting all tracked request controllers on dispose. Risk: low. PR: #3046, merged.
- `src/preload/index.ts`: notification sound playback registered `ended`/`error` listeners for each play, but a failed `audio.play()` or replaced cached audio could leave those listeners attached. Fixed by tracking and running explicit playback listener cleanup. Risk: low. PR: #3047, merged.
- `src/main/browser/cdp-ws-proxy.ts`: CDP proxy startup errors after debugger attach rejected without releasing the debugger/server objects. Fixed the startup failure path to close partial servers and detach the debugger. Risk: low. PR: #3049, merged.

## Validation

- `pnpm vitest run --config config/vitest.config.ts src/main/browser/cdp-ws-proxy.test.ts src/main/speech/model-manager.test.ts src/main/runtime/rpc/unix-socket-transport.test.ts src/relay/dispatcher.test.ts`
- `pnpm run typecheck:node`
- `pnpm exec oxlint src/main/browser/cdp-ws-proxy.ts src/main/runtime/rpc/unix-socket-transport.ts src/main/runtime/rpc/unix-socket-transport.test.ts src/relay/client-request-aborts.ts src/relay/dispatcher.ts src/relay/dispatcher.test.ts src/preload/index.ts src/main/speech/model-manager.ts src/main/speech/model-manager.test.ts`
