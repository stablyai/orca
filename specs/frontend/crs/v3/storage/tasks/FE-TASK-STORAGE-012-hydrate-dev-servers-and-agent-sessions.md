# FE-TASK-STORAGE-012: Hydrate `dev-servers.ts` + `remote-agent-sessions.ts` khi mount

**Solution:** FE-SOL-STORAGE-006 | **CRs:** CR-STORAGE-006, CR-STORAGE-007
**Depends on:** [TASK-BE-STORAGE-005](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-005-audit-infra-fleet-read-handlers.md), [TASK-BE-STORAGE-008](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-008-wscompat-connectivity-and-agent-session-channels.md) (backend-go)
**Status:** 🟡 PARTIAL — dev-servers.ts hydrate ✅ DONE. Backend dependency
(`TASK-BE-STORAGE-007`/`agentSession.listActive`) is now ✅ DONE
(2026-09-08) — but `remote-agent-sessions.ts` hydrate itself is still not
wired, for a NEW, more precise reason than "RPC doesn't exist": the RPC's
`DispatchContext.assigneeHandle` is documented (domain code comment) as a
`KeyedAsyncQueue` serialization key for a terminal-hosted agent worker —
**not** a `worktreeId`, which is what `remote-agent-sessions.ts`'s
`RemoteAgentSession` map is keyed by. Mapping `agentSession.listActive`'s
response onto this slice without a verified `assigneeHandle → worktreeId`
resolution would silently mis-key sessions in the UI. This link doesn't
exist anywhere in the codebase today (same class of gap as
`BACKLOG-006`'s original finding, one level further down) — flagging as a
new, narrower follow-up rather than guessing the mapping.

> **Implementation notes (2026-09-07):**
> - `dev-servers.ts`: added `hydrateDevServers(target: RuntimeClientTarget)` action — calls
>   `callRuntimeRpc(target, 'devServer.listForUser', {})` (a real, non-stub RPC per
>   BE-SOL-STORAGE-002's audit appendix) and unwraps its `{ devServers: DevServer[] }`
>   envelope into `set({ devServers })`. No dedicated `runtime-dev-server-client.ts`-style
>   wrapper existed for `listForUser` (only `accounts-dev-server-connection.ts`'s
>   `listAccountsDevServers`, which targets `devServer.list` and a narrower
>   `AccountsDevServerOption` shape for a different feature) — `callRuntimeRpc` is called
>   directly from the slice, matching the task's own scope (only `dev-servers.ts`/its test).
>   **Existing inline hydrate found:** `useDevServersSync.ts` already calls
>   `window.api.devServer.list()` on mount (desktop-only `devServer.list`, unscoped by
>   department/team) and subscribes to `devServer.onStatusChanged` for live updates —
>   confirmed still untouched/unwired to this new action, same "additive, not a
>   replacement" pattern FE-TASK-STORAGE-013 used for `ssh.ts`. This new action is a
>   testable entry point for the access-control-scoped `listForUser` RPC per
>   CR-STORAGE-006, not yet wired to any mount/reconnect call site (out of scope here).
> - **BUG-013 caveat** (noted in a doc comment on `hydrateDevServers`, not fixed): per
>   BE-SOL-STORAGE-002's audit appendix, `devServer.listForUser`'s team-membership grants
>   were confirmed still ignored as of TASK-BE-STORAGE-005 — a user granted access only
>   via a team (not directly or via department) may see an incomplete list from this
>   hydrate. Out of scope to fix per this task's instructions.
> - No existing "hydrate sync status" observable state was found on this slice (only
>   `persistence-status.ts`'s `persistenceStatus`, which tracks client-state *write*
>   failures — an unrelated concept, and out of scope to touch/extend here) — per the
>   task's own "don't invent new state shape if none exists" instruction, no
>   `devServersSyncState`-style field was added; RPC failures are swallowed silently
>   (no crash, `devServers` left untouched) inside a try/catch, verified by test.
> - `remote-agent-sessions.ts`: **left entirely untouched**, per the explicit correction
>   given for this task run — its hydrate depends on backend-go `agentSession.listActive`,
>   which TASK-BE-STORAGE-007 found blocked (no field maps `DispatchContext` to a user).
> - `impact({target: "createDevServerSlice", direction: "upstream"})` on `orca`:
>   351 symbols / CRITICAL risk — this is the standard fan-out for editing any Zustand
>   slice factory (`AppState` is imported transitively by nearly everything using
>   `useAppStore`), not a signal of real behavioral risk: the change is purely additive
>   (one new action added to the slice's public surface; no existing field, action
>   signature, or behavior was changed). Flagging per CLAUDE.md's HIGH/CRITICAL-risk
>   warning requirement.
> - Verify: `cd frontend && npx vitest run src/renderer/src/store/slices/dev-servers.test.ts`
>   → **11 tests passed** (1 test file, includes 2 new `hydrateDevServers` tests).

---

## Mục tiêu

Thêm action hydrate gọi RPC đọc đã tồn tại (`devServer.listForUser`) và
mới (`agentSession.listActive`) khi mount/reconnect — **không** thay thế
cơ chế cập nhật live hiện tại (IPC event cho agent session).

## Files cần sửa

1. `frontend/src/renderer/src/store/slices/dev-servers.ts` (MODIFY)
2. `frontend/src/renderer/src/store/slices/remote-agent-sessions.ts` (MODIFY)
3. Test file tương ứng

## Nội dung (xem FE-SOL-STORAGE-006 §1-§2 cho code đầy đủ)

```ts
async function hydrateDevServers(target: RuntimeTarget) {
  set({ devServersSyncState: 'pending' })
  try {
    const list = await callRuntimeRpc(target, 'devServer.listForUser', {})
    set({ devServers: list, devServersSyncState: 'synced' })
  } catch (err) {
    set({ devServersSyncState: 'error' })
  }
}

async function hydrateRemoteAgentSessions(target: RuntimeTarget) {
  const active = await callRuntimeRpc(target, 'agentSession.listActive', {})
  set({ remoteAgentSessions: mapDispatchContextsToSessions(active) })
}
```

Gọi `hydrateDevServers()`/`hydrateRemoteAgentSessions()` tại: (a) App
startup, (b) sau khi `getActiveRuntimeTarget()` đổi. (c) sau reconnect
thành công thuộc FE-TASK-STORAGE-016, không implement ở đây.

## ⚠️ Cần xác nhận trước khi viết `mapDispatchContextsToSessions`

Đối chiếu shape `DispatchContextSummary` (từ TASK-BE-STORAGE-007) với
`RemoteAgentSession` hiện có trong frontend — viết adapter rõ ràng, không
giả định field trùng tên tự động map đúng.

## Test cases cần cover

- `hydrateDevServers`: set đúng `devServersSyncState` qua 3 trạng thái
  (`pending` → `synced` hoặc `error`).
- `hydrateDevServers` lỗi RPC: `devServersSyncState = 'error'`, không
  throw ra ngoài caller.
- `hydrateRemoteAgentSessions`: map đúng field từ `DispatchContextSummary[]`
  sang `RemoteAgentSession[]` theo adapter đã viết.
- IPC event vẫn cập nhật `remoteAgentSessions` bình thường SAU khi hydrate
  xong (xác nhận hydrate không ghi đè liên tục, chỉ chạy 1 lần lúc mount).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/store/slices/dev-servers.test.ts src/renderer/src/store/slices/remote-agent-sessions.test.ts
```

## gitnexus

`impact({target: "dev-servers", direction: "upstream"})` và tương đương
cho `remote-agent-sessions` — cả 2 slice hiện "in-memory only" (không có
persistence call), xác nhận thêm hydrate action không phá bất kỳ nơi nào
đang giả định slice này luôn rỗng lúc mount.

## Blocking

Không.
