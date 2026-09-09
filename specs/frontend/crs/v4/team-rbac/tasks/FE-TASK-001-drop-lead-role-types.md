# FE-TASK-001: Bỏ `'lead'` khỏi `OrcaUserRole` (store) và `AuthUser.role` (HTTP type)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-001](../solutions/FE-SOL-001-drop-lead-from-global-role-model.md) Bước 1-2
**CR:** [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md)
**Priority:** 🔴 P0
**Estimated:** 20 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

Backend thật (auth-service/api-gateway) chỉ có 2 role toàn cục (`user`/`admin`, map sang
`developer`/`admin` ở tầng response) — "lead" chưa từng tồn tại cho user thật nào, chỉ đúng nghĩa
ở `RepoRole` (theo từng repo, không đổi ở task này). Thu hẹp 2 type union còn 2 giá trị.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/store/slices/auth.ts` | MODIFY — `OrcaUserRole` |
| `frontend/src/renderer/src/auth/auth-types.ts` | MODIFY — `AuthUser.role` |

## Các bước thực thi

**1. `frontend/src/renderer/src/store/slices/auth.ts`** — thay định nghĩa `OrcaUserRole`:

```typescript
// CR-RBAC-002: backend thật (auth-service) chỉ có 2 role toàn cục (user/admin,
// roleToString ở api-gateway map non-admin → "developer" cho tương thích UI cũ)
// — "lead" chưa từng tồn tại được cho user thật nào. "lead" đúng nghĩa chỉ ở
// RepoRole (theo từng repo, xem RepoMemberManager.tsx), không phải role toàn cục.
export type OrcaUserRole = 'developer' | 'admin'
```

Giữ nguyên tên `'developer'` (không đổi thành `'user'`) — đây đúng là chuỗi backend trả về qua
`roleToString`/`toAuthUserResponse`; đổi tên hiển thị là việc khác, ngoài phạm vi CR này.

**2. `frontend/src/renderer/src/auth/auth-types.ts`** — thay `AuthUser.role`:

```typescript
export type AuthUser = {
  id: string
  email: string
  name: string
  role: 'developer' | 'admin'   // was: 'developer' | 'lead' | 'admin'
  provider: 'none' | SsoProvider
  avatarUrl?: string
}
```

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
# Không được còn khớp nào trong 2 file này (khớp còn lại chỉ hợp lệ ở RepoMemberManager.tsx):
grep -n "'lead'" frontend/src/renderer/src/store/slices/auth.ts frontend/src/renderer/src/auth/auth-types.ts
```

Kết quả `tsc` sau bước này sẽ báo lỗi type ở các nơi còn gán/so sánh `role: 'lead'` — đó chính là
danh sách cần sửa tiếp ở FE-TASK-002/003/004 (không sửa thêm ở task này).

## Không làm ở task này

- Không sửa `UserRoleBadge.tsx`, preload types, hay Hệ B — xem các task riêng.
- Không đổi `RepoRole`/`RepoMemberManager.tsx` — "lead" giữ nguyên đúng nghĩa ở đó.

## Depends on

Không có.

## Blocking

FE-TASK-002 (dùng lại `OrcaUserRole` từ đúng file này). FE-TASK-003, FE-TASK-004 không phụ thuộc
compile trực tiếp (type khác file) nhưng nên hoàn tất cùng đợt để tránh "lead" còn sống rải rác.

## Kết quả thực tế (2026-09-09)

Code hiện tại khớp đúng mô tả trong task (đã xác nhận bằng `codegraph_explore
"OrcaUserRole AuthUser auth.ts auth-types.ts"` — verbatim source cho cả 2 file khớp 100% với đoạn
trích trong task). `impact()` không nhận `OrcaUserRole`/`AuthUser` làm target hợp lệ (gitnexus
không index type alias TS đứng riêng — chỉ trả `"error": "Target not found"`); dùng blast-radius từ
`codegraph_explore` thay thế: `AuthUser` (frontend) có 8 caller (LoginPage.tsx, auth-api-client.ts,
main-web-bootstrap.tsx, auth-types.ts chính nó), `OrcaUserRole` (frontend) có 5 caller
(UserRoleBadge.tsx, store/types.ts, auth.ts chính nó) — risk thấp, đều là consumer nội bộ FE, không
ai gán cứng `'lead'` ngoài phạm vi đã biết (UserRoleBadge/preload/Hệ B — xử lý ở FE-TASK-002/003/004).

Đã sửa đúng 2 file theo kế hoạch:
- `frontend/src/renderer/src/store/slices/auth.ts` — `OrcaUserRole` còn `'developer' | 'admin'`,
  kèm comment CR-RBAC-002 y hệt task.
- `frontend/src/renderer/src/auth/auth-types.ts` — `AuthUser.role` còn `'developer' | 'admin'`.

`grep -n "'lead'"` trên 2 file này: rỗng (đạt yêu cầu verify). `tsc --noEmit` sau khi gộp cả nhóm A
(001-004): baseline có sẵn 147 dòng lỗi TS không liên quan (xác nhận bằng `git stash` + tsc trước
khi sửa, diff = rỗng sau khi sửa) — nhóm A không thêm lỗi type mới nào. Không có gì khác biệt so với
kế hoạch.
