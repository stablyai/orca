---
name: task-provider-parity
description: How issue-tracker providers (GitHub/GitLab/Linear/Jira/Asana) are structured and wired across the codebase
metadata:
  type: project
---

Issue-tracker providers mirror a fixed structure. A new provider (Asana added in PR #4881, mirroring Jira) touches:

- `src/main/<provider>/client.ts` — encrypted token storage (Electron safeStorage), workspace/site selection, `getClients`, `getStatus`, `connect`, `disconnect`, `selectWorkspace`, `isAuthError`.
- `src/main/<provider>/issues.ts` — task reads/mutations, `fanOut` across workspaces, auth-error clears token then rethrows only for single-workspace selection (`shouldThrowAuthError`).
- `src/main/ipc/<provider>.ts` — `ipcMain.handle` registrations; calls `_resetPreflightCache()` on connect/disconnect.
- `src/main/runtime/orca-runtime.ts` + `src/main/runtime/rpc/methods/<provider>.ts` — runtime service methods + zod-validated RPC methods registered in `methods/index.ts`.
- `src/preload/index.ts` + `src/preload/api-types.ts` — IPC bridge.
- `src/renderer/src/runtime/runtime-<provider>-client.ts` — routes to local IPC or remote runtime env (SSH use case).
- `src/renderer/src/store/slices/<provider>.ts` — status, task/search caches (TTL 60s, max 500), optimistic `patch<Provider>Task`. Store methods ignore passed workspaceId and use `getSelectedWorkspaceId(status)`.
- `src/shared/<provider>-types.ts`, `src/shared/task-providers.ts`, `src/shared/types.ts`, `src/shared/workspace-name.ts`, `TaskPage.tsx`.

**Why:** Reviewing parity PRs means checking the new provider matches this established shape rather than judging each concern in isolation.

**How to apply:** When a deviation from the Jira/Linear baseline appears, that is the signal worth flagging. Matching the baseline (even imperfect patterns like the [[max-lines-provider-convention]] disable or the patch search-cache `fetchedAt` asymmetry) is intended.
