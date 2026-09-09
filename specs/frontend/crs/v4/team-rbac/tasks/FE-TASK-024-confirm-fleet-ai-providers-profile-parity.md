# FE-TASK-024: Xác nhận Fleet/AI-providers/Profile (Hệ B) đã có tương đương ở Hệ A (verify-only)

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bước 7
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 30 phút
**Status:** ✅ DONE — 2026-09-09 (verify hoàn tất — kết luận: CÓ gap thật, xem "Kết quả thực tế")

## Mục tiêu

Theo audit gốc, các route `/fleet`, `/ai-providers`, `/profile` của Hệ B đã có tương đương sống ở
Hệ A: `AdminDevServerConsole` (fleet), `ProviderList`, `CompanyProfileAdmin`/`DeptProfileAdmin`.
Task này xác nhận lại tính năng đủ khi implement — không kỳ vọng có gap lớn vì các UI này thuộc Hệ A
đã hoạt động, nhưng cần xác nhận trước khi coi các route tương ứng ở Hệ B an toàn để xoá
(FE-TASK-023 không liệt kê các route này vì audit gốc không xếp chúng vào "11 file cần xoá" — xác
nhận lại phạm vi đó ở đây).

## Các bước thực thi

1. Dùng `codegraph_explore "AdminDevServerConsole"` / `"ProviderList"` /
   `"CompanyProfileAdmin"` / `"DeptProfileAdmin"` để đọc nhanh 4 component này (không đọc toàn
   file thủ công).
2. Đối chiếu tính năng với route Hệ B tương ứng (`/fleet`, `/ai-providers`, `/profile` trong
   `AdminApp.tsx`) — liệt kê bất kỳ tính năng nào Hệ B có mà Hệ A thiếu.
3. Nếu có gap thật: báo cáo lại (không tự ý mở rộng phạm vi CR-RBAC-001 để vá gap này trong task
   này — cần xác nhận có đúng thuộc phạm vi CR-001 hay là 1 CR/feature request riêng).
4. Nếu không có gap: ghi nhận kết luận, coi 3 route này của Hệ B an toàn để xoá cùng đợt với
   FE-TASK-023 (bổ sung vào danh sách xoá của FE-TASK-023 nếu tương ứng file Hệ B tồn tại).

## Files cần sửa

Không có — task này KHÔNG sửa code, chỉ xác nhận + báo cáo.

## Verify

Không có lệnh build/test riêng — kết quả là kết luận bằng văn bản (gap hay không gap), đính kèm
tên component đã đối chiếu.

## Depends on

Không có.

## Blocking

FE-TASK-023 nếu phát hiện thêm file Hệ B cần xoá (`/fleet`, `/ai-providers`, `/profile` route
handler trong `AdminApp.tsx`, nếu có file riêng chưa nằm trong danh sách 11 file đã liệt kê).

## Kết quả thực tế (2026-09-09) — PHÁT HIỆN GAP THẬT, khác kết luận của audit gốc

Đọc 4 component bằng `codegraph_explore "AdminDevServerConsole ProviderList CompanyProfileAdmin
DeptProfileAdmin"` + đối chiếu route Hệ B (`AdminApp.tsx`'s `PageContent`: `/fleet` →
`FleetDashboard`, `/ai-providers` → `ProviderList`, `/profile` → `ProfileAdminPage`
[`CompanyProfileAdmin`+`DeptProfileAdmin`]) với Hệ A hiện tại. Phát hiện quan trọng: blast-radius
của cả 3 component Hệ B (`CompanyProfileAdmin`, `DeptProfileAdmin`, `ProviderList`) chỉ có caller
trong chính `AdminApp.tsx` — xác nhận thêm bằng `grep -rln` toàn `frontend/src`: **0 nơi nào trong
Hệ A import 3 component này**. Đây không phải "đã có tương đương sống ở Hệ A" như audit gốc kết
luận, mà là 3 tính năng khác nhau về bản chất:

1. **`/fleet` (`FleetDashboard`) vs `AdminDevServerConsole` (Hệ A, trong `Settings.tsx`)** — KHÁC
   tính năng, không phải bản thay thế: `FleetDashboard` làm health-monitoring (CPU/mem/reachability
   qua `useFleetHealthPolling`), alert banner, và bulk CSV import (`FleetImportDialog`).
   `AdminDevServerConsole` làm approval workflow (approve/reject dev server), group + department
   access grant, và access-request resolution — hoàn toàn khác nhau. Gap: health
   monitoring/alerts/CSV import không có ở Hệ A.
2. **`/ai-providers` (`ProviderList`) vs Hệ A** — KHÔNG có tương đương nào cả. `ProviderList` quản
   lý AI provider account ở mức tổ chức/fleet (bảng account theo devServerId/scope/status, test
   connection, usage chart). `grep` xác nhận Hệ A's `Settings.tsx` chỉ có "AI Provider Accounts"
   section (`AccountsPane`) — đây là cấu hình **cá nhân** của user hiện tại (per-user credential),
   khác hẳn phạm vi admin/tổ chức của `ProviderList`. Gap: toàn bộ tính năng quản lý AI provider
   account ở mức admin/fleet chưa có ở Hệ A.
3. **`/profile` (`CompanyProfileAdmin`/`DeptProfileAdmin`, dùng `ProfileEditor`+`useProfile`) vs
   `CompanyTab`/`DepartmentsTab` (Hệ A, trong `AdminOrgConsole`)** — KHÁC tính năng: `CompanyTab`/
   `DepartmentsTab` chỉ làm CRUD tenant/company/department (tạo công ty mới, tạo phòng ban, đổi tên)
   qua `window.api.tenantProfile`. `CompanyProfileAdmin`/`DeptProfileAdmin` làm cấu hình
   "OrcaProfile" (model mặc định, resolved settings theo scope user/dept/company) qua
   `callRuntimeRpc('profile.listDepts', ...)`/`useProfile` — 1 hệ thống dữ liệu và mục đích hoàn
   toàn khác (agent/model preference resolution, không phải RBAC/tenant management). Gap: toàn bộ
   tính năng "profile" (model default theo scope) chưa có ở Hệ A.

**Kết luận:** khác với audit gốc, **CÓ gap thật ở cả 3 route** — không chỉ là "chưa xác nhận", mà là
3 tính năng hoàn toàn không tồn tại (hoặc khác mục đích) ở Hệ A hiện tại. Theo đúng chỉ dẫn của task
("không tự ý mở rộng phạm vi CR-RBAC-001 để vá gap này"), KHÔNG code gì thêm ở đây. Cũng KHÔNG bổ
sung `/fleet`, `/ai-providers`, `/profile`'s file Hệ B vào danh sách xoá của FE-TASK-023 (task đó
nằm ngoài phạm vi 13 task được giao lần này, không tự ý sửa) — ngược lại, phát hiện này có nghĩa
FE-TASK-023 (khi tới lượt chạy) PHẢI loại trừ các route/file này khỏi danh sách xoá cho tới khi có
quyết định: (a) build tính năng tương đương ở Hệ A trước (1 CR/feature request riêng, không phải
CR-RBAC-001), hoặc (b) business xác nhận các tính năng này không cần giữ (deprecated có chủ đích).
Không có lệnh build/test riêng cho task này (đúng "Verify" đã ghi trong task) — kết luận là kết quả
chính của task.
