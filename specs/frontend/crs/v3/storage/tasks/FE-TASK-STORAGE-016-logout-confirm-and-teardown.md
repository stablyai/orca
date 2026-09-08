# FE-TASK-STORAGE-016: `useLogout.ts` — confirm dialog + đóng session chủ động trước khi xoá

**Solution:** FE-SOL-STORAGE-007 | **CR:** CR-STORAGE-008(a)
**Depends on:** FE-TASK-STORAGE-014 (`connectivityStatus` để biết `connectionId` đang mở); phần backend hoàn chỉnh cần [TASK-BE-STORAGE-012](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-012-explicit-teardown-and-integration-tests.md)
**Status:** ✅ DONE (2026-09-08) — end-to-end functional now that
`TASK-BE-STORAGE-012` Parts C/D wired `connection.teardown` through
api-gateway's wscompat layer AND made infra-fleet-service notify the live
agent. Frontend logout confirm + `closeAllActiveSessions()` were already
✅ DONE and tested against the intended contract as of 2026-09-07 (no
frontend code change needed today — the call site was already written
correctly, only its stale "not wired yet" doc comment was updated). Real
vitest run: `npx vitest run` on
`frontend/src/renderer/src/hooks/__tests__/useLogout.test.ts` → 7 passed
(7), re-confirmed after the comment update. **Known follow-up, not
blocking**: the confirm step uses `window.confirm`, not the codebase's
shared `useConfirmationDialog`/`ConfirmationDialogProvider`
(`components/confirmation-dialog.tsx`) — impact analysis
(`gitnexus impact useLogout upstream`) showed 2 of `useLogout`'s 4 real
call sites (`AdminApp.tsx`, and `main-web-bootstrap.tsx`'s
`WebConnectionBannerWrapper`, rendered as a sibling of `<App/>`, not inside
it) mount outside `ConfirmationDialogProvider`'s tree; that hook throws
when used without its Provider, and oxlint's `react-hooks/rules-of-hooks`
(error-level) forbids calling it conditionally (no try/catch) to work
around that. A UX polish item, not a functional gap — `window.confirm`
correctly blocks and confirms today.

---

## Mục tiêu

Logout giờ cần xác nhận người dùng + đóng chủ động mọi connection đang mở
qua backend-go TRƯỚC khi xoá `localStorage`/`sessionStorage` — để
infra-fleet-service nhận đúng tín hiệu "đóng chủ động" thay vì phải tự suy
luận từ mất kết nối đột ngột.

## Files cần sửa

1. `frontend/src/renderer/src/hooks/useLogout.ts` (MODIFY, dòng ~50, 55)
2. Kiểm tra component confirm-dialog dùng chung đã có trong repo trước khi
   tạo mới (theo `AGENTS.md`'s nguyên tắc tránh trùng lặp) — dùng lại nếu
   có.
3. Test file tương ứng

## Nội dung (xem FE-SOL-STORAGE-007 mục (b) cho code đầy đủ)

```ts
async function logout() {
  const confirmed = await showConfirmDialog({ /* ...nội dung xem solution... */ })
  if (!confirmed) return

  await closeAllActiveSessions()   // MỚI — gọi connection.teardown cho mọi connectionId đang mở

  localStorage.clear()
  sessionStorage.clear()
  redirectToLogin()
}

async function closeAllActiveSessions(): Promise<void> {
  const target = getActiveRuntimeTarget()
  if (target.kind !== 'environment') return
  const { connections } = useAppStore.getState().connectivityStatus
  await Promise.allSettled(
    Object.keys(connections).map((connectionId) =>
      callRuntimeRpc(target, 'connection.teardown', { connectionId })
    )
  )
}
```

## ⚠️ Cần xác nhận trước khi implement

Tên wscompat channel `connection.teardown` cần khớp đúng với
`TeardownConnection` gRPC đã có ở `infra-fleet-service` — kiểm tra namespace
thật (có thể cần đăng ký channel mới nếu chưa expose qua wscompat; nếu
vậy, đây là 1 task bổ sung phía backend-go ngoài BE-SOL-STORAGE-003's
phạm vi hiện tại — báo cáo lại, không tự thêm channel không có trong thiết
kế).

## Test cases cần cover

- `logout()` không làm gì nếu `confirmed === false` (không xoá, không gọi
  `closeAllActiveSessions`).
- `logout()` gọi `closeAllActiveSessions()` TRƯỚC `localStorage.clear()`
  (assert thứ tự gọi).
- `closeAllActiveSessions()` không throw khi 1 vài `connection.teardown`
  reject (dùng `Promise.allSettled`, không chặn logout).
- `closeAllActiveSessions()` no-op khi `target.kind !== 'environment'`
  (desktop-local).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/hooks/useLogout.test.ts
```

## gitnexus

`impact({target: "logout", direction: "upstream"})` trước khi sửa —
`useLogout` khả năng được gọi từ nhiều điểm UI (menu, settings, session
expiry banner), xác nhận đầy đủ trước khi đổi signature/behavior.

## Blocking

Không — task cuối cùng của FE-SOL-STORAGE-007.
