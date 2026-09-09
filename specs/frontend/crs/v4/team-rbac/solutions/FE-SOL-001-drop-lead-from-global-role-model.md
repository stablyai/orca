# FE-SOL-001: Bỏ "lead" khỏi role toàn cục (`OrcaUserRole`/`AuthUser.role`) — chỉ giữ `developer|admin`

> 🔲 Proposed — chưa cài đặt.

## CR Reference

- **CR:** [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md)
- **Mức độ:** 🔴 P0
- **Phạm vi solution này:** CHỈ phần frontend của CR-RBAC-002 (mục A — "Sửa UI để phản ánh đúng thực
  tế"). Phần B (truyền role claim `tenant.WithRole` qua bearer-JWT middleware, sửa
  `callerGlobalRole` ở `project-service`) là backend-go, không thuộc solution này — chờ backend-go's
  BE-SOL tương ứng của CR-RBAC-002.

## Impact analysis (gitnexus, đã chạy lại — không dùng số cũ trong CR)

| Symbol | Direction | Risk | Impacted | Ghi chú |
|---|---|---|---|---|
| `UserRoleBadge` (`frontend/.../components/auth/UserRoleBadge.tsx`) | upstream | LOW | 3 (1 direct: `UserAvatarMenu` → `WebUserAvatarSection` → `SidebarToolbar`) | Component sống thật, đang render trong titlebar web |
| `checkSession` (`frontend/.../store/slices/auth.ts`) | upstream | LOW | 0 | Không ai gọi trực tiếp ngoài chính `AuthSlice` (được gọi qua `store.checkSession()`, gitnexus không thấy caller vì đây là access qua Zustand action, không phải import trực tiếp) |

`OrcaUserRole` là type alias — gitnexus's `impact()` không index được type alias làm target khả thi
(`Target 'OrcaUser' not found` khi thử; tương tự với `OrcaUserRole`). Đã bù bằng `grep` chính xác
(narrow, không phải khảo sát lại toàn bộ) cho literal `'lead'` trong `frontend/src` — kết quả dưới
đây là danh sách đầy đủ, xác nhận qua `codegraph_explore`.

## Bối cảnh (đã xác nhận lại)

- `OrcaUserRole` (`frontend/src/renderer/src/store/slices/auth.ts:7`) = `'developer' | 'lead' | 'admin'`.
- `AuthUser.role` (`frontend/src/renderer/src/auth/auth-types.ts:16`) = cùng union 3 giá trị — đây
  là type tầng HTTP mà `fetchCurrentUser()`/`loginLocal()` trả về.
- Backend thật (`backend-go/services/api-gateway/.../auth_admin_routes.go`'s `roleToString`, đã đọc
  verbatim) chỉ map `ROLE_ADMIN → "admin"`, mọi giá trị khác → `"user"` — **không có "developer"
  cũng không có "lead"** ở tầng REST admin-console. Ở tầng `/auth/me` (session thật), comment trong
  `auth_admin_routes.go:196-202` xác nhận role 2-valued là "a deliberate simplification from the old
  TS backend's 3-role model" — không có user thật nào có `role === 'lead'`.
- `frontend/src/shared/admin-user-types.ts`'s `AdminUserRole = 'admin' | 'user'` — **type ĐÚNG** đã
  tồn tại sẵn, dùng bởi `AdminOrgConsole`'s `UsersTab`/`CreateUserForm` (Hệ A, xác nhận qua
  `codegraph_explore`: 2 `<SelectItem>` `user`/`admin`, không có `lead`). Đây là mẫu convention CR
  này cần nhân rộng sang các type còn lại, không phải phát minh mới.
- `UserRoleBadge.tsx` (`frontend/src/renderer/src/components/auth/UserRoleBadge.tsx`) — **component
  sống thật**, `ROLE_LABELS: Record<OrcaUserRole, string>` có `lead: 'lead'`. Impact xác nhận nó
  được `UserAvatarMenu` gọi, và `UserAvatarMenu` được `SidebarToolbar`/`WebUserAvatarSection` render
  — đây chính là chip role hiện trong titlebar web thật, không phải dead code.
- `RepoRole` (`frontend/src/renderer/src/components/project/RepoMemberManager.tsx:32`) =
  `'developer' | 'lead' | 'admin'` — **đúng theo quyết định của CR-002**: "lead" chỉ có ý nghĩa ở
  ngữ cảnh 1 repo cụ thể (khớp `backend-go/policy/orca-authz/repo.rego`'s `RepoRole`). File này
  **không sửa** trong solution này.
- Dead code phụ phát hiện thêm (không có trong audit gốc): `frontend/src/shared/rbac-types.ts` định
  nghĩa lại `OrcaUser`/role 3-valued riêng, **0 file nào import nó** (`grep` xác nhận) — trùng lặp
  hoàn toàn với `store/slices/auth.ts`. Việc xoá file này được gộp vào
  [FE-SOL-002](./FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) (cùng
  nhóm dọn field `teams`/`projects`) để tránh 2 solution cùng sửa 1 file.

## Giải pháp

### Bước 1 — `OrcaUserRole` chỉ còn 2 giá trị

**File:** `frontend/src/renderer/src/store/slices/auth.ts` (MODIFY)

```typescript
// CR-RBAC-002: backend thật (auth-service) chỉ có 2 role toàn cục (user/admin,
// roleToString ở api-gateway map non-admin → "developer" cho tương thích UI cũ)
// — "lead" chưa từng tồn tại được cho user thật nào. "lead" đúng nghĩa chỉ ở
// RepoRole (theo từng repo, xem RepoMemberManager.tsx), không phải role toàn cục.
export type OrcaUserRole = 'developer' | 'admin'
```

(Giữ nguyên tên `'developer'` — không đổi thành `'user'` — vì đây đúng là chuỗi backend trả về qua
`roleToString`/`toAuthUserResponse`, đổi tên hiển thị là việc khác, ngoài phạm vi CR này.)

### Bước 2 — `AuthUser.role` (tầng HTTP) khớp lại

**File:** `frontend/src/renderer/src/auth/auth-types.ts` (MODIFY)

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

### Bước 3 — `UserRoleBadge.tsx` bỏ nhãn "lead"

**File:** `frontend/src/renderer/src/components/auth/UserRoleBadge.tsx` (MODIFY)

```tsx
import type { OrcaUserRole } from '../../store/slices/auth'

type Props = { role: OrcaUserRole }

const ROLE_LABELS: Record<OrcaUserRole, string> = {
  developer: 'developer',
  admin: 'admin'
}
```

Vì `Record<OrcaUserRole, string>` giờ chỉ cần 2 key, TypeScript tự chặn nếu ai đó truyền `role:
'lead'` — không cần thêm runtime check.

### Bước 4 — Preload type + handler dead-code có tham chiếu `'lead'` (giữ compile sạch)

**File:** `frontend/src/preload/api-types.ts` (MODIFY, dòng ~3414 — kiểu tham số của
`onAuthStateChanged`, kênh IPC xác nhận KHÔNG có emitter nào trong `backend/src/main` — dead
plumbing, nhưng vẫn phải sửa type để không vỡ build)

```typescript
// event.user.role trong onAuthStateChanged
role: 'developer' | 'admin'   // was: 'developer' | 'lead' | 'admin'
```

**File:** `frontend/src/renderer/src/hooks/useIpcEvents.ts` (không cần sửa logic — chỉ tự hết lỗi
type sau khi Bước 4 đổi type ở `api-types.ts`, vì object literal ở đây gán thẳng `event.user.role`).

### Bước 5 — Hệ B (Admin SPA cũ) — sửa theo đúng "Changes Required" của CR-002, dù sẽ bị xoá bởi CR-RBAC-001 sau này

CR-RBAC-002 chạy **trước** CR-RBAC-001 (xem README's "Thứ tự thực thi"), nên trong lúc Hệ B còn
sống, nó vẫn phải phản ánh đúng role model — tránh admin dùng Hệ B tạo ra 1 "lead" ảo trong lúc
chờ cutover.

**File:** `frontend/src/renderer/src/components/admin/UserForm.tsx` (MODIFY)

```tsx
<select value={role} onChange={e => setRole(e.target.value as any)}>
  <option value="developer">Developer</option>
  <option value="admin">Admin</option>
</select>
```

**File:** `frontend/src/renderer/src/components/admin/admin-api-client.ts` (MODIFY)

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

**File:** `frontend/src/renderer/src/components/admin/PolicyForm.tsx` (MODIFY) — bỏ checkbox
`roles.has('lead')` (dòng ~122), giữ `developer`/`admin`.

**File:** `frontend/src/renderer/src/components/admin/UsersPage.tsx` (MODIFY) — bỏ
`<option value="lead">Lead</option>` (dòng ~73).

### Bước 6 — Cập nhật `docs/features/F32-team-rbac.md`

CR-002's tiêu chí chấp nhận yêu cầu tài liệu phản ánh đúng model. Đây là thay đổi tài liệu (không
phải code) — cập nhật bảng Role: global 2 tier (`developer` hiển thị cho non-admin / `admin`),
repo-scoped 3 tier (`developer/lead/admin`, không đổi). Không nằm trong phạm vi kỹ thuật của
solution FE, nhưng ghi nhận ở đây vì CR-002 liệt kê chung 1 "Changes Required".

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/store/slices/auth.ts` | MODIFY — `OrcaUserRole` bỏ `'lead'` |
| `frontend/src/renderer/src/auth/auth-types.ts` | MODIFY — `AuthUser.role` bỏ `'lead'` |
| `frontend/src/renderer/src/components/auth/UserRoleBadge.tsx` | MODIFY — `ROLE_LABELS` bỏ entry `lead` |
| `frontend/src/preload/api-types.ts` | MODIFY — type `onAuthStateChanged`'s `event.user.role` bỏ `'lead'` |
| `frontend/src/renderer/src/components/admin/UserForm.tsx` | MODIFY — bỏ `<option value="lead">` (Hệ B, tạm thời tới khi CR-RBAC-001 xoá file) |
| `frontend/src/renderer/src/components/admin/admin-api-client.ts` | MODIFY — `AdminUser.role`, `AdminPolicy.roles` bỏ `'lead'` |
| `frontend/src/renderer/src/components/admin/PolicyForm.tsx` | MODIFY — bỏ checkbox role `lead` |
| `frontend/src/renderer/src/components/admin/UsersPage.tsx` | MODIFY — bỏ `<option value="lead">` |
| `docs/features/F32-team-rbac.md` | MODIFY (tài liệu) — bảng Role phản ánh 2-tier global / 3-tier repo-scoped |

Các file **KHÔNG sửa** (đã xác nhận đúng, không cần đổi):
`frontend/src/shared/admin-user-types.ts` (đã đúng 2-valued), `admin-org-console-users-tab.tsx`
(Hệ A, đã đúng 2-valued), `RepoMemberManager.tsx` (RepoRole giữ nguyên `lead` — đúng theo quyết
định CR-002).

## Verification (khi cài đặt)

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json   # xác nhận không còn ai gán role: 'lead' còn sót
cd frontend && npx vitest run src/renderer/src/components/auth/__tests__/UserRoleBadge.test.tsx
```

Sau khi sửa, chạy lại `grep -rn "'lead'" frontend/src/renderer/src frontend/src/shared
frontend/src/preload` — chỉ còn khớp trong `RepoMemberManager.tsx` (đúng, không đổi).

## Không làm ở solution này

- Truyền role claim qua bearer-JWT (`tenant.WithRole`), sửa `callerGlobalRole` — backend-go, thuộc
  BE-SOL của CR-RBAC-002 phần B.
- Thêm role toàn cục thứ 3 thật — quyết định sản phẩm, ngoài phạm vi CR.
- Đổi `RepoRole`/`RepoMemberManager.tsx` — đây là nơi "lead" đúng nghĩa, giữ nguyên.
- Xoá `frontend/src/shared/rbac-types.ts` (dead type trùng lặp) — gộp vào FE-SOL-002 để không xử lý
  trùng 1 file ở 2 solution.
