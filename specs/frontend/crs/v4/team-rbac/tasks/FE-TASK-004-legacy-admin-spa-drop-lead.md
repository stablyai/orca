# FE-TASK-004: Hệ B (Admin SPA cũ) — bỏ role "lead" khỏi UserForm/PolicyForm/UsersPage/admin-api-client

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-001](../solutions/FE-SOL-001-drop-lead-from-global-role-model.md) Bước 5
**CR:** [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md)
**Priority:** 🔴 P0
**Estimated:** 30 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

CR-RBAC-002 chạy **trước** CR-RBAC-001 (cutover Admin SPA sang `AdminOrgConsole`, xem
[FE-TASK-023](./FE-TASK-023-remove-legacy-admin-spa.md)). Trong lúc Hệ B (Admin SPA cũ, sẽ bị xoá
sau) còn sống, nó vẫn phải phản ánh đúng role model 2-tier — tránh admin dùng Hệ B tạo ra 1 "lead"
ảo trong lúc chờ cutover.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/admin/UserForm.tsx` | MODIFY — bỏ `<option value="lead">` |
| `frontend/src/renderer/src/components/admin/admin-api-client.ts` | MODIFY — `AdminUser.role`, `AdminPolicy.roles` bỏ `'lead'` |
| `frontend/src/renderer/src/components/admin/PolicyForm.tsx` | MODIFY — bỏ checkbox role `lead` (dòng ~122) |
| `frontend/src/renderer/src/components/admin/UsersPage.tsx` | MODIFY — bỏ `<option value="lead">Lead</option>` (dòng ~73) |

## Các bước thực thi

**`UserForm.tsx`:**

```tsx
<select value={role} onChange={e => setRole(e.target.value as any)}>
  <option value="developer">Developer</option>
  <option value="admin">Admin</option>
</select>
```

**`admin-api-client.ts`:**

```typescript
export type AdminUser = {
  // ...
  role: 'developer' | 'admin'   // was: 'developer' | 'lead' | 'admin'
}

export type AdminPolicy = {
  // ...
  roles: ('developer' | 'admin')[]   // was: ('developer' | 'lead' | 'admin')[]
}
```

**`PolicyForm.tsx`** (dòng ~122): xoá checkbox ứng với `roles.has('lead')`, giữ nguyên 2 checkbox
`developer`/`admin`.

**`UsersPage.tsx`** (dòng ~73): xoá dòng `<option value="lead">Lead</option>` khỏi `<select>` role.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -rn "'lead'\|\"lead\"\|>Lead<" frontend/src/renderer/src/components/admin/
```

Kết quả grep trên phải rỗng sau khi sửa.

## Lưu ý

File này (Hệ B) sẽ bị **xoá toàn bộ** ở [FE-TASK-023](./FE-TASK-023-remove-legacy-admin-spa.md)
(CR-RBAC-001) sau khi `AdminOrgConsole` cutover xong. Nếu FE-TASK-023 chạy trước task này (thứ tự
lệch), có thể bỏ qua task này — không có ý nghĩa sửa code sắp xoá. Chỉ thực thi task này nếu Hệ B
còn đang sống tại thời điểm implement.

## Depends on

Không có.

## Blocking

Không có (không ai import các type này ngoài chính Hệ B).

## Kết quả thực tế (2026-09-09)

Xác nhận Hệ B (`frontend/src/renderer/src/components/admin/`) còn sống tại thời điểm thực thi —
`ls` liệt kê đủ `AdminApp.tsx`, `UserForm.tsx`, `PolicyForm.tsx`, `UsersPage.tsx`,
`admin-api-client.ts` — FE-TASK-023 (xoá Hệ B) chưa chạy, nên task này thực thi bình thường (không
bỏ qua). `impact()` cho `UserForm`/`PolicyForm`/`UsersPage` trả ambiguous (3 candidate mỗi tên do
trùng tên biến local trong `AdminApp.tsx`) — bản thật (file riêng, `Function:.../UserForm.tsx`) đều
có `impactedCount = 0`, còn bản re-export/lazy-load qua `AdminApp.tsx` có `impactedCount = 3, risk:
LOW` — khớp nhận định "Hệ B tự chứa, sắp xoá" của task.

Đã sửa đúng 4 file theo kế hoạch:
- `UserForm.tsx` — bỏ `<option value="lead">Lead</option>`.
- `admin-api-client.ts` — `AdminUser.role` và `AdminPolicy.roles` còn `'developer' | 'admin'`.
- `PolicyForm.tsx` — bỏ checkbox `roles.has('lead')`.
- `UsersPage.tsx` — bỏ `<option value="lead">Lead</option>` khỏi filter dropdown.

`grep -rn "'lead'|"lead"|>Lead<" frontend/src/renderer/src/components/admin/`: chỉ còn khớp trong
`__tests__/TeamAdmin.test.tsx` (repo-level `RepoRole`, không phải phạm vi CR-002 — đúng ngoại lệ ghi
trong FE-TASK-001). `tsc --noEmit`: không phát sinh lỗi mới. `npx vitest run
src/renderer/src/components/admin/__tests__/`: 31/31 test pass (6 file test), không cần sửa test
nào trong nhóm này. Không có gì khác biệt so với kế hoạch.
