# FE-TASK-022: Xác nhận Users tab đã đầy đủ (verify-only, không sửa code)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bối cảnh #1 + Bước 5
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 15 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

CR-001 gốc viết: "tab này đã gọi `updateUserRole` — chỉ cần bổ sung create/deactivate/reactivate
nếu còn thiếu". Solution đã đọc verbatim `admin-org-console-users-tab.tsx` và xác nhận: `CreateUserForm`
(gọi `window.api.admin.createUser`) và `UsersTab`'s `handleRoleChange`/`handleActiveToggle` (gọi
`updateUserRole`/`deactivateUser`/`reactivateUser`) **đã có đủ cả 5 thao tác**, dùng đúng
`AdminUserRole = 'user'|'admin'`. **Không có việc gì để làm ở Users tab** — task này chỉ xác nhận
lại 1 lần nữa bằng test trước khi coi CR-RBAC-001's phần Users là hoàn tất.

## Các bước thực thi

1. Đọc lại `frontend/src/renderer/src/components/settings/admin-org-console-users-tab.tsx` (dùng
   `codegraph_explore "admin-org-console-users-tab"` thay vì đọc toàn file).
2. Xác nhận đủ 5 thao tác: create, update role, deactivate, reactivate, (list — mặc định có).
3. Chạy test hiện có, không cần viết test mới nếu coverage đã đủ.

## Files cần sửa

Không có — task này KHÔNG sửa code. Nếu bước 2 phát hiện thiếu thao tác (khác kết luận của
solution), dừng lại và báo cáo thay vì tự ý bổ sung — đây là sai lệch so với solution đã verify,
cần xác nhận lại phạm vi trước khi code.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/settings/__tests__/admin-org-console-users-tab.test.tsx
```

## Depends on

Không có.

## Blocking

Không có (chỉ là gate xác nhận trước khi coi CR-RBAC-001 hoàn tất toàn bộ).

## Kết quả thực tế (2026-09-09)

Đọc `frontend/src/renderer/src/components/settings/admin-org-console-users-tab.tsx` bằng
`codegraph_explore` (không đọc toàn file thủ công) — xác nhận đủ cả 5 thao tác đúng kết luận của
solution:
- **create**: `CreateUserForm` (dòng 28+) gọi `window.api.admin.createUser({...})` (dòng 48).
- **list**: `UsersTab`'s `useEffect` gọi `window.api.admin.listUsers()` (dòng 133).
- **update role**: `handleRoleChange` gọi `window.api.admin.updateUserRole({ userId, role })` (dòng
  145), dùng đúng `AdminUserRole` (2-tier).
- **deactivate/reactivate**: `handleActiveToggle` (dòng 156+) chọn `window.api.admin.deactivateUser`
  hoặc `.reactivateUser` tuỳ trạng thái hiện tại (dòng 160-161).

**Phát hiện lệch so với task:** lệnh verify trong task
(`npx vitest run src/renderer/src/components/settings/__tests__/admin-org-console-users-tab.test.tsx`)
trỏ tới 1 file test **không tồn tại** — xác nhận bằng `find`/`grep -rl` trên toàn
`frontend/src` (0 kết quả) và chạy thẳng lệnh vitest đó (kết quả: "No test files found"). Không có
bất kỳ test nào cho `UsersTab`/`admin-org-console-users-tab.tsx`/`AdminOrgConsole` trong repo hiện
tại. Theo đúng phạm vi task ("Files cần sửa: Không có — task này KHÔNG sửa code"), KHÔNG tự ý viết
test mới ở đây (việc đó vượt quá "verify-only" — nếu cần bổ sung coverage, đó là quyết định riêng
ngoài phạm vi 13 task được giao). Xác nhận thay thế bằng đọc code trực tiếp: kết luận không đổi —
Users tab đã đầy đủ, không có gap nào so với audit gốc của CR-RBAC-001.
