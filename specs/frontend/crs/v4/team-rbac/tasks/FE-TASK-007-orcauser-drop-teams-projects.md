# FE-TASK-007: `OrcaUser` bỏ field `teams`/`projects` chết + sửa `checkSession`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md) Phần A
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 20 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

`OrcaUser.teams`/`.projects` không có nguồn dữ liệu thật nào đổ vào (2 nơi hard-code `teams: [],
projects: []`, xem FE-TASK-008/009) — RBAC scoping thật là Department/Team grant ở
`infra-fleet-service`, không phải field này. Xoá field khỏi type nguồn (`store/slices/auth.ts`)
trước, các callsite còn lại sửa ở task riêng.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/store/slices/auth.ts` | MODIFY — `OrcaUser` type + `checkSession` |

## Các bước thực thi

```typescript
export type OrcaUser = {
  id: string
  email: string
  name: string
  avatarUrl?: string
  role: OrcaUserRole
  // teams/projects: xoá — không nguồn nào đổ dữ liệu thật (CR-RBAC-004);
  // scoping RBAC thật là infra-fleet-service's Department/Team grant, không
  // phải field này trên OrcaUser.
}
```

Cập nhật `checkSession` (~dòng 69-77) — bỏ `teams: [], projects: []` khỏi object literal gán vào
store.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
```

`tsc` sẽ báo lỗi ở các callsite còn gán `teams`/`projects` vào `OrcaUser` — đó là danh sách cần sửa
ở FE-TASK-008 và FE-TASK-009 (không sửa thêm ở task này).

## Lưu ý xung đột file

File này (`store/slices/auth.ts`) cũng bị sửa bởi **FE-TASK-001** (SOL-001, sửa `OrcaUserRole` —
type khác, không đụng `OrcaUser`/`checkSession`). Khuyến nghị áp dụng FE-TASK-001 trước task này để
tránh 2 patch chồng lấn khi áp dụng tuần tự, dù về mặt nội dung 2 thay đổi độc lập nhau (khác
type/khác đoạn code).

## Depends on

Không có.

## Blocking

FE-TASK-008, FE-TASK-009 (cả 2 gán `teams`/`projects` vào `OrcaUser`, sẽ lỗi compile cho tới khi
sửa theo).

## Kết quả thực tế (2026-09-09)

`impact()` không nhận `OrcaUser` làm target hợp lệ (gitnexus không index type alias TS đứng riêng)
— dùng `codegraph_explore` để xác nhận blast radius thay thế: `OrcaUser` được `AuthSlice` tham
chiếu, tiêu thụ qua `useAuthUser()`/`useAuthSession()` (`useAuthSession.ts`) và trực tiếp trong
`checkSession`. Đã thực hiện đúng FE-TASK-001 trước (sửa `OrcaUserRole`) rồi mới tới task này (sửa
`OrcaUser`/`checkSession`) như khuyến nghị "Lưu ý xung đột file" — áp dụng tuần tự không có
conflict.

Đã bỏ `teams: string[]` / `projects: string[]` khỏi `OrcaUser` (kèm comment CR-RBAC-004 y hệt task)
và bỏ `teams: [], projects: []` khỏi object literal trong `checkSession`, tại
`frontend/src/renderer/src/store/slices/auth.ts`. `tsc --noEmit` báo lỗi đúng ở 2 nơi dự kiến
(`main-web-bootstrap.tsx`'s `WebRoot` và `useIpcEvents.ts`'s `onAuthStateChanged` handler) — xử lý ở
FE-TASK-008/009 (đã làm tiếp ngay sau, cùng đợt). Sau khi cả 3 task (007-009) hoàn tất: `tsc
--noEmit` không còn lỗi mới (diff với baseline 147-dòng = rỗng). Không có gì khác biệt so với kế
hoạch.
