# FE-TASK-021: Tab "Sessions" trong `AdminOrgConsole` (theo-user, không phải all-users)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bước 4
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 1 giờ
**Status:** ✅ DONE — 2026-09-11

**Kết quả thực tế:** Đúng thiết kế gốc — tạo `admin-org-console-sessions-tab.tsx`'s `UserSessionsPanel`
(Dialog, không phải tab/route độc lập — đúng lý do RPC chỉ scoped theo 1 user). Danh sách session (IP/
user agent/created/last-seen), nút revoke từng session (`forceRevokeSession`) + revoke tất cả
(`forceRevokeAllSessions`). Đã thêm nút "View sessions" vào mỗi row của `admin-org-console-users-tab.tsx`
mở panel này với đúng `userId`. `npx tsc --noEmit`: 0 lỗi mới so với baseline.

## Lưu ý UX quan trọng (khác Hệ B cũ)

`admin_routes.go`'s `handleListAllSessions` xác nhận **không có RPC "list tất cả session mọi
user"** — chỉ `ListSessionsForUser` (scoped theo 1 `user_id`, bắt buộc query param, trả 400 nếu
thiếu; comment tại chỗ: "Follow up with a real cross-user RPC (SOL-001) if the admin console
actually needs the all-users view live"). Vì vậy tab Sessions ở `AdminOrgConsole` **phải** thiết kế
theo user đang chọn (ví dụ nút "View sessions" trên mỗi row của Users tab, mở panel Sessions cho
đúng user đó) thay vì bảng "tất cả session" như `SessionsPage.tsx` (Hệ B) cũ. Đây là khác biệt UX
bắt buộc do RPC không hỗ trợ — ghi rõ quyết định này trong code comment.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/settings/admin-org-console-sessions-tab.tsx` | CREATE |
| `frontend/src/renderer/src/components/settings/AdminOrgConsole.tsx` | MODIFY — thêm entry point mở panel Sessions theo user (không phải tab độc lập all-users) |

## Các bước thực thi

**1. Tạo `admin-org-console-sessions-tab.tsx`** — panel/dialog nhận `userId`, hiển thị session của
đúng user đó:

```tsx
// CR-RBAC-001: backend-go chỉ có ListSessionsForUser (scoped theo 1 user), không
// có RPC cross-user — khác Hệ B's SessionsPage.tsx (bảng tất cả session). Thiết
// kế theo-user: mở từ 1 hàng trong Users tab, không phải route/tab độc lập.
export function UserSessionsPanel({ userId }: { userId: string }): React.JSX.Element {
  const [sessions, setSessions] = useState<AdminSession[]>([])

  useEffect(() => {
    window.api.admin.listSessionsForUser({ userId }).then(setSessions).catch((err) => toast.error(String(err)))
  }, [userId])

  // revoke 1 session: window.api.admin.revokeSession({ sessionId })
  // revoke tất cả session của user: window.api.admin.forceRevokeAllSessionsForUser({ userId })
}
```

**2. `admin-org-console-users-tab.tsx`** (đã có sẵn) — thêm nút "View sessions" trên mỗi row, mở
`UserSessionsPanel` với `userId` tương ứng (dialog/sheet, không phải navigation sang route khác).

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/AdminOrgConsole.test.tsx
```

## Depends on

FE-TASK-017 (namespace `admin.listSessionsForUser`/`revokeSession`/
`forceRevokeAllSessionsForUser`).

## Blocking

FE-TASK-023 (xoá Hệ B's `SessionsPage.tsx` — chỉ sau khi tab/panel này sống ổn định).
