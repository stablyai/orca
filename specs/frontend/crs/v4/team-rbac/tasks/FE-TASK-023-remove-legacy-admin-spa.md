# FE-TASK-023: Xoá Hệ B (Admin SPA cũ) sau khi 4 tab mới sống ổn định

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-004](../solutions/FE-SOL-004-consolidate-admin-spa-into-admin-org-console.md) Bước 6
**CR:** [CR-RBAC-001](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-001-consolidate-admin-surface-to-backend-go.md)
**Priority:** 🔴 P0
**Estimated:** 1.5 giờ
**Status:** ✅ DONE — 2026-09-11 (một phần đã sửa lại phạm vi so với kế hoạch gốc — xem "Kết quả thực tế")

## Kết quả thực tế — ⚠️ pivot khỏi danh sách xoá gốc, dựa trên phát hiện của FE-TASK-024

Kế hoạch gốc liệt kê xoá **11 file + `admin-main.tsx`** (toàn bộ `components/admin/*` + entry point,
kéo theo `AdminApp.tsx`/`AdminLayout.tsx` biến mất hoàn toàn). Nhưng FE-TASK-024 (chạy trước) đã phát
hiện: `AdminApp.tsx`'s route `/fleet`, `/ai-providers`, `/profile` (→ `FleetDashboard`, `ProviderList`,
`CompanyProfileAdmin`/`DeptProfileAdmin`) là **3 tính năng thật, không trùng lặp với Hệ A**, và **0 nơi
nào khác trong app import 3 component đó** (xác nhận lại bằng `impact()` — risk LOW nhưng vẫn `direct: 0`
callers ngoài `AdminApp.tsx`). Xoá `AdminApp.tsx` như kế hoạch gốc sẽ **âm thầm mất 3 tính năng thật**
(không phải dead-code cleanup, mà là regression) — đúng cảnh báo FE-TASK-024 đã ghi rõ: *"FE-TASK-023
PHẢI loại trừ các route/file này khỏi danh sách xoá cho tới khi có quyết định."*

**Quyết định đã áp dụng (kỹ thuật, không phải business — giữ tính năng an toàn thay vì xoá liều):**

- ✅ **Xoá thật** (đúng kế hoạch gốc, đã có tương đương sống ở Hệ A qua Sprint 2/3): `UsersPage.tsx`,
  `UserForm.tsx`, `PoliciesPage.tsx`, `PolicyForm.tsx`, `TeamAdmin.tsx`, `SessionsPage.tsx`,
  `AuditPage.tsx`, `admin-api-client.ts` (+ 6 file test tương ứng).
- ✅ **Xoá thêm ngoài danh sách gốc** (hệ quả tự nhiên, đã xác nhận `impact()` = 0 caller khác):
  `AdminDashboard.tsx` (dashboard "/" chỉ hiển thị stats nguồn Hệ B — `useAdminStats`/`fetchAdminSessions`
  — không phải tính năng riêng, mất ý nghĩa khi các domain nó tổng hợp đã bị xoá) + hook
  `useAdminStats.ts` (chỉ 1 caller duy nhất, chính là `AdminDashboard.tsx` vừa xoá).
- ⚠️ **KHÔNG xoá** `AdminApp.tsx`, `AdminLayout.tsx`, `admin-main.tsx` — **trim lại** thay vì xoá:
  `AdminRoute` chỉ còn `/fleet | /ai-providers | /profile`, `NAV_ITEMS` chỉ còn 3 mục, `/fleet` thành
  route mặc định (thay cho `/` dashboard đã xoá). `admin-main.tsx` không đổi (vẫn mount `AdminApp`).

**Việc còn treo, cần quyết định business riêng (ngoài phạm vi kỹ thuật CR-RBAC-001):** SPA rút gọn này
(`AdminApp.tsx` + 3 route) vẫn tồn tại song song với `AdminOrgConsole`/`AdminDevServerConsole` (Hệ A)
như 1 route/bundle riêng (`admin-main.tsx`, không nhúng trong `Settings.tsx`) — về lâu dài nên: (a) build
tương đương 3 tính năng này vào Hệ A (Settings) rồi xoá nốt SPA này, hoặc (b) business xác nhận có thể bỏ
health-monitoring/CSV-import/AI-provider-account-admin/OrcaProfile-admin (deprecated có chủ đích). Không
tự quyết định thay business ở đây.

**Verify:**
- `impact()` chạy cho từng symbol trước khi xoá (9 symbol, risk LOW/impactedCount 0 hoặc chỉ đúng
  `AdminApp.tsx`'s lazy-import nội bộ đang bị xoá cùng đợt — không có caller sống nào ngoài phạm vi).
- `npx tsc --noEmit`: 146 lỗi (giảm 1 so với baseline 147 — `AuditPage.test.tsx`'s lỗi lint có sẵn biến
  mất cùng file bị xoá), 0 lỗi mới.
- `npx vitest run` (phạm vi `components/admin/`, `components/settings/`, `admin/`): 594/597 test pass,
  3 test fail duy nhất ở `settings-setup-guide-progress-hook.test.tsx` — xác nhận **không liên quan**
  (0 tham chiếu "admin" trong file đó; lỗi về số bước feature-wall-setup-guide, khớp đúng baseline lỗi
  tsc đã biết từ trước ở `SetupGuideSidebarEntry.test.tsx`, do 1 phiên không liên quan khác đang sửa).
- Grep cuối (`AdminApp|admin-api-client|PolicyForm|TeamAdmin|SessionsPage|...`) — mọi match còn lại đều
  false positive (comment lịch sử, `CreateUserForm`/`CreatePolicyForm` chứa substring, `AdminApp.tsx`
  chính nó vẫn tồn tại có chủ đích).
- `detect_changes({scope:"compare", base_ref:"main"})`: kết quả saturated (483KB, vượt giới hạn output)
  do toàn bộ working tree có rất nhiều thay đổi từ các phiên song song khác — theo đúng quy tắc "Stop on
  Saturation" của CLAUDE.md, không cố đọc hết; dựa vào tsc/vitest ở trên làm lưới an toàn chính thay thế.
- `backend/src/main/admin/*`, `backend/src/main/team/*` — **không đụng tới**, đúng "Không thuộc phạm vi
  task này" đã ghi sẵn.

## ⚠️ Quy tắc bắt buộc

**MUST chạy `impact({target, direction:"upstream"})` cho TỪNG symbol ngay trước khi xoá** — không
dùng số liệu suy đoán từ solution doc (chỉ mang tính tham khảo, đã ghi rõ "chưa chạy impact() trong
solution này"). Cảnh báo nếu bất kỳ symbol nào trả về risk HIGH/CRITICAL trước khi tiếp tục xoá.
Chạy `detect_changes({scope:"compare", base_ref:"main"})` trước khi commit bước xoá này (tách
riêng commit khỏi các commit additive FE-TASK-018..021).

## Trình tự xoá (xác nhận trước khi xoá từng symbol/file)

| Symbol/File | Trước khi xoá phải xác nhận |
|---|---|
| `admin-main.tsx`, `AdminApp.tsx`, `AdminLayout.tsx`, `AdminDashboard.tsx` | Không còn route/bundle nào trỏ tới (kiểm tra `admin-index.html`/build config); `impact({target:"AdminApp", direction:"upstream"})` |
| `admin-api-client.ts`, `UsersPage.tsx`, `UserForm.tsx` | Không còn import ngoài các file Hệ B khác đang xoá cùng đợt |
| `PoliciesPage.tsx`, `PolicyForm.tsx` | Sau khi FE-TASK-018 (tab Policies) sống ổn định |
| `TeamAdmin.tsx` | Sau khi FE-TASK-020 (tab Teams) sống ổn định |
| `SessionsPage.tsx` | Sau khi FE-TASK-021 (tab/panel Sessions) sống ổn định |
| `AuditPage.tsx` | Sau khi FE-TASK-019 + FE-TASK-014/015/016 (tab Audit + filter actor/outcome) sống ổn định |

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/admin/admin-main.tsx` | DELETE |
| `frontend/src/renderer/src/components/admin/*` (11 file: `AdminApp.tsx`, `AdminLayout.tsx`, `AdminDashboard.tsx`, `admin-api-client.ts`, `UsersPage.tsx`, `UserForm.tsx`, `PoliciesPage.tsx`, `PolicyForm.tsx`, `TeamAdmin.tsx`, `SessionsPage.tsx`, `AuditPage.tsx`) | DELETE |

## Các bước thực thi

1. Với mỗi symbol/file trong bảng trên, chạy `impact({target: "<TênSymbol>", direction:
   "upstream"})` — xác nhận impactedCount chỉ còn các file Hệ B khác đang xoá cùng đợt (không có
   caller sống nào ngoài phạm vi xoá).
2. Xoá theo đúng thứ tự bảng trên (từ "vỏ ngoài" `admin-main.tsx`/`AdminApp.tsx` vào "lõi" từng
   trang), để nếu dừng giữa chừng, phần còn lại vẫn ở trạng thái nhất quán (route đã gỡ trước khi
   xoá trang con).
3. Kiểm tra build config/`admin-index.html` (nếu Admin SPA có entry HTML riêng) không còn trỏ tới
   bundle đã xoá.

## Không thuộc phạm vi task này

`backend/src/main/admin/*` (4 handler file) và `backend/src/main/team/TeamService.ts` +
`team-rpc-handler.ts` — đây là code Electron `backend/` (legacy, bị loại khỏi phạm vi sửa của bộ
task này theo ràng buộc dự án). Ghi nhận trong PR/commit rằng các file backend legacy này cần dọn ở
1 thay đổi riêng, ngoài phạm vi frontend — không tự ý xoá cùng đợt.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run
grep -rln "AdminApp\|admin-api-client\|PolicyForm\|TeamAdmin\|SessionsPage\|components/admin/AuditPage" frontend/src
```

Grep cuối phải rỗng (trừ chính các file bị xoá không còn tồn tại để grep match).

## Depends on

FE-TASK-018 (Policies tab), FE-TASK-019 (Audit tab) + FE-TASK-014/015/016 (filter actor/outcome),
FE-TASK-020 (Teams tab), FE-TASK-021 (Sessions tab) — tất cả phải sống ổn định trước. FE-TASK-004
(SOL-001's sửa "lead" trên Hệ B) trở nên vô nghĩa nếu chưa merge — bỏ qua an toàn, vì file đang bị
xoá ở đây.

## Blocking

Không có (bước cuối của CR-RBAC-001).
