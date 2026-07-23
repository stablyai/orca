# Decision-gate attention implementation

## Scope

Implemented the first narrow Orca slice for persisted orchestration decision gates. Pending gates are now visible in the existing left-sidebar attention area as **Decisions**, with a durable count and a popover that resolves configured options directly or accepts exact free text when no options exist. Existing CLI `gate-create`, `gate-list`, and `gate-resolve` behavior is unchanged.

Open-PR review found no overlapping gate-attention implementation; the relevant open orchestration PR (#10185) concerns coordinator wake after `worker_done`, and #10149 is renderer selector performance.

## Architecture and data flow

1. `orchestration.gateCreate` persists the gate and blocks the task through `OrchestrationDb.createGate`.
2. Only after persistence succeeds, the RPC handler emits `decisionGatesChanged` through the runtime notifier and runtime client-event stream. Coordinator-created gates validate the same `string[]` option contract before persistence and use the same event.
3. The local authoritative-window notifier and remote runtime client-event subscription converge on `orca:decision-gates-changed` in the renderer. Only the local persisted-create event carries gate/question notification data and dispatches the existing native/mobile notification pipeline, keyed by gate ID; remote refresh snapshots carry no notification payload, preventing duplicate OS/mobile delivery.
4. The runtime client-event ready snapshot always includes a `pendingDecisionGates` boolean. A remote reconnect/replay therefore refreshes `gateList` for both `true` and `false`, including when every gate resolved while disconnected and stale rows must be cleared.
5. The Decisions popover reads pending gates from the existing `orchestration.gateList` RPC on mount and on change events. Its merge helper deduplicates by gate ID; the database remains the durable source of truth.
6. Resolution uses `BEGIN IMMEDIATE` plus `UPDATE ... WHERE status='pending'`. Only the first resolver records a value; stale/concurrent resolves return an already-resolved error, never overwrite the first answer, and only move an actually blocked task to ready when no sibling gate remains pending. Configured options remain UI suggestions: exact free text is accepted by RPC, CLI, and UI.
7. Gate creation validates the task and performs persistence, active-dispatch completion, and blocking in one transaction. Unknown tasks and terminal (`completed`/`failed`) tasks are rejected rather than creating orphan gates or reviving finished work.
8. Database initialization restores blocked task status for persisted pending gates. Renderer mount and remote ready snapshots list persisted gates, so restart/reconnect restores attention without replaying one notification per gate.

No parallel notification or attention store was introduced.

## Files changed

- Runtime/RPC/event flow: `src/main/runtime/orca-runtime.ts`, `src/main/runtime/orchestration/coordinator.ts`, `src/main/runtime/rpc/methods/orchestration-gates.ts`, `src/shared/runtime-client-events.ts`, `src/renderer/src/runtime/runtime-client-events.ts`.
- Main/preload renderer bridge: `src/main/window/attach-main-window-services.ts`, `src/preload/index.ts`, `src/preload/api-types.ts`, `src/renderer/src/web/web-preload-api.ts`, `src/renderer/src/hooks/useIpcEvents.ts`.
- Existing notification pipeline: `src/shared/types.ts`, `src/main/ipc/notification-ipc-admission.ts`, `src/main/ipc/notification-options.ts`, `src/main/ipc/notifications.ts`, `mobile/src/notifications/notification-routing.ts`.
- UI: `src/renderer/src/components/orchestration/DecisionGateAttention.tsx`, `usePendingDecisionGates.ts`, `decision-gate-attention.ts`, `src/renderer/src/components/sidebar/SidebarNav.tsx`, localization catalogs.
- Tests: orchestration RPC lifecycle, startup reconciliation, notification admission/options, renderer merge/options helper, mobile allowlist regression, and existing IPC event regression coverage.

## Test evidence

- Final focused suite: **297/297 passed** across atomic/stale resolution, transactional create validation, sibling pending gates, free-text resolution with configured options, coordinator option validation, reconnect snapshots for both pending and all-cleared states, local/remote notification routing, existing IPC events, and UI state helpers.
- `pnpm lint`: passed. Existing oxlint warnings remain in unrelated browser/SSH/terminal files.
- `pnpm typecheck`: passed.
- `pnpm build`: passed, including desktop/web and macOS native helpers. Existing Vite chunk-size warnings remain.
- Earlier full `pnpm test`: **36,361 passed, 61 skipped, 115 failed** under Node 26. Remaining failures were baseline/environmental localStorage availability (`--localstorage-file` absent) in unrelated renderer tests; the project declares Node 24. Follow-up changes were covered by focused suites, including the final 297-test run rather than rerunning that known-environmental full failure.

## Cross-platform, SSH, mobile, and security review

- No platform-specific paths, keybindings, native modules, or Git/provider behavior were added. UI uses documented tokens and existing shadcn Button/Input/Popover primitives.
- Remote runtime/SSH ownership is respected: gate list/resolve uses `getActiveRuntimeTarget`, and the remote ready snapshot refreshes the same surface after reconnect even when events were missed.
- Headless runtimes persist and expose gates through existing RPC; attention appears when a desktop/web client connects and lists pending gates.
- The runtime notifier targets only the authoritative local window, while remote clients receive runtime client events. Remote/snapshot events intentionally refresh without notification payload, so only one host-side native/mobile notification is produced per persisted gate; gate-ID cooldown remains defense in depth.
- Mobile notification routing accepts the new source, but mobile RPC list/resolve was intentionally **not** allowlisted because no focused mobile resolution UI was added. Exposing mutation authority without a discoverable mobile surface would be a partial unsafe API. Mobile list/resolve UI remains an explicit follow-up.
- Notification inputs pass the existing bounded IPC admission layer. Questions are rendered as text, option keys are index-based, malformed option JSON degrades to free text, and no HTML/shell/provider action is introduced.

## Screenshots needed

Before a PR, capture:

1. Sidebar Decisions badge with one and multiple pending gates.
2. Popover with configured options in light and dark themes.
3. Free-text gate resolution, including disabled/loading/error states.
4. Windows/Linux rendering if available; macOS alone is insufficient for final visual evidence.

## Residual follow-ups

- Add a dedicated mobile pending-decisions surface, then narrowly allowlist `orchestration.gateList` and `orchestration.gateResolve` with mobile UI tests.
- Add richer worktree/task context and click routing once orchestration tasks gain stable workspace attribution; this slice deliberately avoids guessing local paths for SSH/headless gates.
- Consider a persistent Activity-feed gate section if the experimental Agents surface becomes the canonical global inbox. The always-visible sidebar entry is used now because it is discoverable even when that experiment is disabled.
- `timeoutGate` is currently unused. Before exposing it, define task-state semantics (including sibling pending gates) and make its gate/task transition transactional rather than expanding this attention slice.
