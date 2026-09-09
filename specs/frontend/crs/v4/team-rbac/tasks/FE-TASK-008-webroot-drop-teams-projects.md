# FE-TASK-008: `WebRoot`'s `useEffect` bỏ `teams`/`projects` khỏi `setCurrentUser`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) Phần A
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 10 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

`WebRoot` (`web/main-web-bootstrap.tsx:187`) là nơi hard-code `teams: [], projects: []` thứ 2 khi
gọi `store.setCurrentUser(...)`. Sau khi FE-TASK-007 xoá field khỏi `OrcaUser`, chỗ này phải sửa
theo để hết lỗi compile.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/web/main-web-bootstrap.tsx` | MODIFY — `WebRoot`'s `useEffect` (~dòng 234-242) |

## Các bước thực thi

1. Mở `frontend/src/renderer/src/web/main-web-bootstrap.tsx`, tìm `useEffect` trong `WebRoot`
   (~dòng 234-242) gọi `store.setCurrentUser({...})`.
2. Bỏ 2 field `teams: [], projects: []` khỏi object literal truyền vào `setCurrentUser`.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
grep -n "teams:\s*\[\]\|projects:\s*\[\]" frontend/src/renderer/src/web/main-web-bootstrap.tsx
```

Grep phải rỗng sau khi sửa.

## Depends on

FE-TASK-007 (cần `OrcaUser` đã bỏ field trước, nếu không TypeScript không báo lỗi rõ ở đây và dễ
bỏ sót).

## Blocking

Không có.

## Kết quả thực tế (2026-09-09)

Xác nhận vị trí thật bằng `grep -n "teams:\s*\[\]\|projects:\s*\[\]"
frontend/src/renderer/src/web/main-web-bootstrap.tsx` — khớp dòng 240-241 (lệch nhẹ so với
"~234-242" ghi trong task nhưng đúng cùng khối `useEffect` gọi `store.setCurrentUser(...)` trong
`WebRoot`, dòng 234-242 tổng thể). `impact()` không áp dụng được cho khối `useEffect` inline (không
phải symbol độc lập); dựa vào lỗi `tsc` phát sinh từ FE-TASK-007 để xác nhận đây đúng là 1 trong các
callsite cần sửa.

Đã bỏ `teams: [], projects: []` khỏi object literal truyền cho `store.setCurrentUser(...)`, giữ
nguyên `id/email/name/avatarUrl/role`. `grep -n "teams:\s*\[\]\|projects:\s*\[\]"` trên file: rỗng
sau khi sửa. `tsc --noEmit`: không phát sinh lỗi mới (kết hợp cùng FE-TASK-007/009, diff với
baseline = rỗng). Không có gì khác biệt so với kế hoạch.
