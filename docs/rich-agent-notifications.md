# Rich Agent Notifications

## Problem

`agent-task-complete` notifications now include pane-scoped agent context when available. The renderer producer (`onAgentBecameIdle` in `connectPanePty`) dispatches `source` + `terminalTitle` + `paneKey`; `useNotificationDispatch` enriches with repo/worktree labels, focus hint, and an optional agent-status snapshot from `agentStatusByPaneKey`.

`AgentStatusEntry` already stores richer normalized fields in renderer state (`agentStatusByPaneKey`): `state`, `prompt`, `agentType`, `toolName`, `toolInput`, `lastAssistantMessage`, `interrupted`.

## Goal

Use the best available `AgentStatusEntry` snapshot for the emitting pane to enrich `agent-task-complete` notification text, while preserving fallback behavior when status is missing.

## Non-goals

- No parser/ingestion/retention changes for agent status.
- No click-routing changes.
- No notification action buttons.
- No change to desktop cooldown policy.

## Verified Constraints

- The only renderer producer for `agent-task-complete` is `onAgentBecameIdle` in `pty-connection.ts`.
- `NotificationDispatchRequest` includes optional agent-status fields.
- Main-process formatter (`buildNotificationOptions`) is shared by desktop and mobile dispatch.
- Desktop cooldown/dedupe is in main (`recentNotifications`, 5s, keyed by `worktreeId ?? worktreeLabel ?? 'global'`).
- Mobile dispatch happens before desktop support/settings/source/focus/cooldown guards. Enriched title/body will affect mobile too.
- Focus suppression currently checks `BrowserWindow.getAllWindows().find(...)` (first live window), not the sender window. In multi-window setups this can suppress/allow incorrectly.

## Design

1. Renderer notification event shape includes optional `paneKey`.

`connectPanePty` already has the canonical pane key (`makePaneKey(tabId, leafId)`). Pass it only for `agent-task-complete`.

2. Defer task-complete dispatch briefly, then snapshot agent status in `useNotificationDispatch`.

`onAgentBecameIdle` waits a short grace window before dispatching `agent-task-complete`. Title-based idle can arrive before the final hook status update; delaying at the producer lets `useNotificationDispatch` read the richer pane snapshot without adding a second notification source.

At dispatch time, read `useAppStore.getState().agentStatusByPaneKey[paneKey]` once. Forward only bounded display fields:
- `agentType`
- `agentState`
- `agentPrompt`
- `agentToolName`
- `agentToolInput`
- `agentLastAssistantMessage`
- `agentInterrupted`

This is intentionally window-local and may be stale/racy; no retries.

3. `NotificationDispatchRequest` in `src/shared/types.ts` carries optional agent fields.

Add the optional fields above. Do not pass full `AgentStatusEntry`.

4. Update main formatter for `agent-task-complete`.

Use richer fields when present, with hard bounds/single-line normalization in main before constructing title/body.

Suggested title policy:
- `blocked`/`waiting`: `<Agent> needs input in <worktree>`
- `done` + `interrupted`: `<Agent> stopped in <worktree>`
- otherwise: `<Agent> finished in <worktree>`

Suggested body priority:
- prompt preview
- assistant preview
- tool context
- repo/title fallback (current behavior)

5. Preserve existing fallback behavior.

If no `paneKey` or no entry, preserve current `repoLabel`/`terminalTitle` formatting for `agent-task-complete`.

## Edge Cases To Handle

- Status missing because `removeAgentStatus`/`dropAgentStatus` ran before dispatch.
- Status lag: working→idle notification may race status updates; the grace window covers ordinary same-turn lag, then falls back deterministically.
- Unknown/custom `agentType` values must render safely.
- `lastAssistantMessage` may be multiline/large; main must re-bound.
- `terminal-bell` must not include agent fields.
- Multi-window divergence: each renderer snapshots its own store; two windows may produce different rich payloads for the same worktree.
- External/runtime races are acceptable; deterministic fallback is preferred over coordination.

## Known Consistency Gaps (Out Of Scope Unless Explicitly Addressed)

- Desktop focus suppression is window-agnostic today (first focused window, not sender window).
- Desktop cooldown does not apply to mobile dispatch; mobile may still receive both events.
- Source toggles are desktop-only in current flow because mobile dispatch runs before those checks.

## Tests

- `pty-connection.test.ts`: `agent-task-complete` dispatch includes `paneKey`.
- `pty-connection.test.ts`: delayed hook status arriving during the grace window enriches the notification.
- `notifications.test.ts`: rich formatter behavior + fallback parity.
- `notifications.test.ts`: dedupe remains keyed by worktree/worktreeLabel/global for desktop path.
- Add/adjust test coverage for shared formatter impact on mobile payload construction if runtime path is exercised.
