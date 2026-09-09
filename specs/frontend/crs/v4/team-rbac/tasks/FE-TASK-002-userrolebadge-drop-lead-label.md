# FE-TASK-002: `UserRoleBadge.tsx` bỏ nhãn "lead"

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-001](../solutions/FE-SOL-001-drop-lead-from-global-role-model.md) Bước 3
**CR:** [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md)
**Priority:** 🔴 P0
**Estimated:** 15 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

`UserRoleBadge` là component **sống thật** (render trong titlebar web qua `UserAvatarMenu` →
`WebUserAvatarSection`/`SidebarToolbar` — đã xác nhận qua `impact()`, impactedCount = 3). Sau khi
FE-TASK-001 thu hẹp `OrcaUserRole` còn 2 giá trị, `ROLE_LABELS` phải khớp lại.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/components/auth/UserRoleBadge.tsx` | MODIFY |

## Các bước thực thi

```tsx
import type { OrcaUserRole } from '../../store/slices/auth'

type Props = { role: OrcaUserRole }

const ROLE_LABELS: Record<OrcaUserRole, string> = {
  developer: 'developer',
  admin: 'admin'
}
```

Vì `Record<OrcaUserRole, string>` giờ chỉ cần 2 key, TypeScript tự chặn nếu ai đó truyền `role:
'lead'` — không cần thêm runtime check nào khác trong file này.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run src/renderer/src/components/auth/__tests__/UserRoleBadge.test.tsx
```

Nếu test cũ có case `role: 'lead'`, xoá/sửa case đó (không còn giá trị hợp lệ theo type).

## Depends on

FE-TASK-001 (cần `OrcaUserRole` đã thu hẹp còn 2 giá trị để `Record<OrcaUserRole, string>` tự chặn
type).

## Blocking

Không có.

## Kết quả thực tế (2026-09-09)

Xác nhận code khớp đúng audit gốc: `impact({target: "UserRoleBadge", direction: "upstream"})` trả
`impactedCount = 3`, `risk: "LOW"` — đúng như task mô tả (`UserAvatarMenu` → `WebUserAvatarSection`
→ `SidebarToolbar`, module "Auth"/"Components"). Đã sửa `ROLE_LABELS` trong
`frontend/src/renderer/src/components/auth/UserRoleBadge.tsx` còn đúng 2 key `developer`/`admin`
(TypeScript tự chặn `Record<OrcaUserRole, string>` sau khi FE-TASK-001 thu hẹp type). Test cũ
`UserRoleBadge.test.tsx` có 1 case `role="lead"` không còn hợp lệ theo type mới — đã xoá case đó
(không sửa thành case khác, vì "lead" không còn ý nghĩa trong role model 2-tier).

`npx tsc --noEmit -p tsconfig.json`: không phát sinh lỗi mới (147 dòng lỗi baseline có sẵn, không
đổi trước/sau — xác nhận qua diff). `npx vitest run
src/renderer/src/components/auth/__tests__/UserRoleBadge.test.tsx`: 3/3 test pass sau khi xoá case
"lead". Không có gì khác biệt so với kế hoạch.
