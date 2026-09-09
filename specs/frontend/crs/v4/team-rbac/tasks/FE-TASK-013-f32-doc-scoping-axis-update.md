# FE-TASK-013: Cập nhật `docs/features/F32-team-rbac.md` — scoping axis là Team/Department, không phải Project

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-002](../solutions/FE-SOL-002-remove-dead-server-visibility-selector-and-wire-team-grant.md)
**CR:** [CR-RBAC-004](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-004-project-team-scoped-server-visibility.md)
**Priority:** 🔴 P0
**Estimated:** 15 phút
**Status:** ✅ DONE — 2026-09-09

## Kết quả thực tế

- Phát hiện khi thực thi: mục "Project-scoped Server Visibility" trong `docs/features/F32-team-rbac.md`
  đã bị backend-go's **TASK-BE-013/BE-SOL-004** sửa song song (uncommitted) — đã thêm sẵn 1 note
  xác nhận đúng scoping axis thật là Team/Department (qua `ListDevServersForUser` +
  `infra-fleet-service`'s dev-server-group grant + `tenant-service`'s `GetUserProfile`/
  `ListTeamsForUser`), không phải Project — khớp phần lớn yêu cầu bước 1-2 của task này.
- Không ghi đè/xoá note của TASK-BE-013. Chỉ **bổ sung 1 đoạn addendum** ngay sau, nêu cụ thể phía
  frontend: scoping axis được thao tác qua `devServerGroup.grant({granteeKind: 'department'|'team',
  ...})` trong `GroupsAndGrantsTab` (`AdminDevServerConsole.tsx`, vừa wire xong ở FE-TASK-012 trong
  phiên này) — không còn field `project`/`OrcaUser.projects` nào trong path này (đã xoá, FE-TASK-007/
  010) — và khẳng định rõ ràng **không có kế hoạch thêm trục scoping "Project"** — đây là quyết định
  đã chốt của CR-RBAC-004 (yêu cầu cụ thể bước 3 của FE-TASK-013 mà note TASK-BE-013 chưa nêu rõ
  bằng từ "không có kế hoạch"/"đã chốt").
- Verify: `grep -n "project" docs/features/F32-team-rbac.md` — các dòng còn lại (`project_id`,
  policy table cũ, SQL cũ...) đều nằm trong khối code lịch sử đã được note TASK-BE-013 đánh dấu "OLD
  design sketch — kept for history, do not treat as current contract" ngay phía trên. Không còn chỗ
  nào mô tả sai lệch "Project" như 1 trục scoping đang active.
- Đây là thay đổi tài liệu thuần tuý (không đụng code) — không cần `impact()`/`tsc`/vitest cho task
  này; các phần code liên quan (FE-TASK-006..012) đã verify riêng trong file task của chúng.
- Đã làm SAU FE-TASK-005 (đúng thứ tự "Depends on" — 2 patch vào cùng file không xung đột vì mỗi
  patch nhắm 1 mục khác nhau trong doc: Roles vs Project-scoped Server Visibility).

## Mục tiêu

F32 hiện mô tả (hoặc ngụ ý) server visibility scoping theo "Project" — CR-004 xác nhận quyết định
kiến trúc thật là Team/Department grant ở `infra-fleet-service`, không mở thêm trục "Project". Cập
nhật tài liệu cho khớp sau khi FE-TASK-006..012 xong.

## Files cần sửa

| File | Action |
|------|--------|
| `docs/features/F32-team-rbac.md` | MODIFY (tài liệu) |

## Các bước thực thi

1. Tìm đoạn mô tả server-visibility scoping trong F32.
2. Sửa lại: scoping axis đúng là **Team/Department grant** (qua `DevServerGroup`'s
   `devServerGroup.grant({granteeKind: 'department'|'team', ...})`), không phải field
   `project`/`OrcaUser.projects` (đã xoá vì dead code, xem FE-TASK-007/010).
3. Ghi rõ: không có kế hoạch thêm trục scoping "Project" mới — đây là quyết định đã chốt của
   CR-RBAC-004.

## Verify

```bash
grep -n "project" docs/features/F32-team-rbac.md
```

Đọc lại đoạn liên quan để xác nhận không còn mô tả sai lệch về "Project" như 1 trục scoping.

## Depends on

FE-TASK-005 (SOL-001 cũng sửa cùng file `docs/features/F32-team-rbac.md`, phần bảng Role) — làm
FE-TASK-005 trước để tránh conflict khi áp dụng 2 patch tuần tự vào cùng file. Nên làm sau
FE-TASK-006 đến FE-TASK-012 để mô tả đúng trạng thái code cuối.

## Blocking

Không có.
