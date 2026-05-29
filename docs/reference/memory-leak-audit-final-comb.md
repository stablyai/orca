# Memory Leak Audit Final Comb

Started: 2026-05-29 PDT

Final tracker branch: `nwparker/mem-leak-final-comb-tracker`, based on `origin/main` at `869661cbba` after the final-comb fix PRs merged.

Objective: run one more complete pass across the current Orca tree for missed listener, timer, observer, worker, socket, watcher, subscription, abort, and disposable leaks; open scoped PRs for confirmed stranglers; include risk level and merge low-risk PRs.

## Codebase Inventory

Tracked code files, from `git ls-files`:

| Bucket            | Files | Status  |
| ----------------- | ----: | ------- |
| `src/renderer`    |  1584 | Checked |
| `src/main`        |   856 | Checked |
| `src/shared`      |   245 | Checked |
| `mobile/src`      |   100 | Checked |
| `tests/e2e`       |    72 | Checked |
| `src/relay`       |    65 | Checked |
| `src/cli`         |    65 | Checked |
| `config/scripts`  |    33 | Checked |
| `mobile/app`      |    16 | Checked |
| `other-code`      |     5 | Checked |
| `src/preload`     |     6 | Checked |
| `mobile/packages` |     5 | Checked |
| Total             |  3052 | Checked |

## Scan Log

- 2026-05-29: Created fresh final-comb branch from current `origin/main`.
- 2026-05-29: Fast-forwarded the final-comb branch as `origin/main` moved; final tracker is based on `869661cbba`.
- 2026-05-29: Counted 3341 broad risk-pattern hits across `src`, `mobile`, `tests`, `config`, and `native` on the final post-fix tree.
- 2026-05-29: Re-ran heuristic buckets after fixes:
  - `addEventListener` without same-file `removeEventListener`: 37 remaining. Reviewed as React Native subscriptions with `.remove()`, injected WebView document-lifetime scripts, `{ once: true }` image load handlers, IPC abort-signal test listeners, singleton image-cache invalidation, owned pane-divider DOM, and test fixture listeners.
  - `setInterval` without `clearInterval`: 1 remaining, a test comment string.
  - `setTimeout` without same-file `clearTimeout`: 233 remaining. Reviewed remaining main-process hits as sleep helpers, intentional app relaunch/exit delays, socket idle timeout ownership, usage-scanner yield points, and startup force-exit behavior. Confirmed final-comb timer findings are fixed in PRs listed below.
  - Observers without `disconnect`: 0.
  - Workers without `terminate`: 0.
  - Abort controllers without `abort`: 1 test-only controller passed through the abortable API under test.
  - Watchers without close/unwatch: no production misses; remaining heuristic hits are provider type/comment references.
- 2026-05-29: Re-ran React effect scan and spot-checked candidates. Remaining hits had cleanup returns (`clearTimeout`, `clearInterval`, `removeEventListener`, IPC unsubscribe) or were short one-shot UI focus/open delays.

## Findings

| PR | Risk | Status | Finding | Resolution |
| -- | ---- | ------ | ------- | ---------- |
| [#3305](https://github.com/stablyai/orca/pull/3305) | LOW | Merged | Browser reload fallback timer retained the reload promise closure, webContents reference, and listeners until the 10s fallback fired even after `did-finish-load`/`did-fail-load`. | Clear the fallback timer on early settle, guard duplicate cleanup, and test with fake timers. |
| [#3306](https://github.com/stablyai/orca/pull/3306) | LOW | Merged | Native notification retention timers stayed scheduled after close/click cleanup, retaining notification closures until fallback expiry. | Clear notification fallback timers on release, detach native listeners, and cover dispatch/startup/accessibility notification paths. |
| [#3307](https://github.com/stablyai/orca/pull/3307) | LOW | Merged | Local-network permission UDP prompt kept its 1s fallback timer and socket error listener after the send callback settled first. | Clear the fallback timer, remove the error listener, and test the `developerPermissions:request` local-network path. |

No higher-risk findings remained after the final pass, so no second higher-risk mitigation pass was needed.

## Validation

- `pnpm vitest run --config config/vitest.config.ts src/main/browser/agent-browser-bridge.test.ts`
- `pnpm vitest run --config config/vitest.config.ts src/main/browser/agent-browser-bridge.test.ts src/main/ipc/notifications.test.ts src/main/computer/permissions.test.ts src/main/ipc/developer-permissions.test.ts`
- `pnpm vitest run --config config/vitest.config.ts src/main/ipc/notifications.test.ts src/main/computer/permissions.test.ts`
- `pnpm vitest run --config config/vitest.config.ts src/main/ipc/developer-permissions.test.ts`
- `pnpm exec oxlint src/main/browser/agent-browser-bridge.ts src/main/browser/agent-browser-bridge.test.ts src/main/ipc/notifications.ts src/main/ipc/notifications.test.ts src/main/computer/permissions.ts src/main/computer/permissions.test.ts src/main/ipc/developer-permissions.ts src/main/ipc/developer-permissions.test.ts`
- `pnpm run typecheck:node`
