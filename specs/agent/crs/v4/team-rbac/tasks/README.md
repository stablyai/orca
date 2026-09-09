# Agent Tasks — Team RBAC (v4)

**Solutions:** [../solutions/README.md](../solutions/README.md)
**CRs:** [docs/crs/v4/team-rbac/](../../../../../../docs/crs/v4/team-rbac/README.md) — CR-RBAC-001 → CR-RBAC-007

## Không có task nào trong thư mục này

`solutions/README.md` đã xác nhận (bằng GitNexus/CodeGraph, không suy đoán): **cả 7 CR đều không cần
sửa bất kỳ file nào trong `agent/`** — agent không tham gia quyết định authn/authz/audit của hệ thống
(mọi quyết định RBAC/SSO/OPA xảy ra ở `backend-go` trước khi 1 request được relay tới agent; agent chỉ
thực thi thao tác đã được cho phép). Xem bảng "Verdict" + mục "Evidence" trong solutions/README.md cho
bằng chứng chi tiết từng CR.

Vì vậy không có `TASK-AG-RBAC-NNN.md` nào được tạo — tạo task ở đây sẽ là việc bịa ra công việc mà
không CR nào trong 001–007 yêu cầu.

## Việc dọn dẹp phụ (tuỳ chọn, không thuộc CR nào trong bộ này)

`solutions/README.md` §1 phát hiện `agent/src/shared/rbac-types.ts` là dead code (0 caller thật trong
`agent/`, chỉ tự tham chiếu chính nó) — bản vendor thừa từ kiến trúc TS-Electron cũ (`CR-006-team-rbac`).
Nếu muốn dọn, đây là 1 task độc lập, nhỏ, KHÔNG phụ thuộc và KHÔNG được yêu cầu bởi CR-RBAC-001..007:

- **Việc cần làm:** xoá `agent/src/shared/rbac-types.ts`.
- **Trước khi xoá:** chạy lại `impact({target:"resolveUserPermissions", direction:"upstream", file_path:"agent/src/shared/rbac-types.ts"})` và `impact({target:"OrcaUser", direction:"upstream", file_path:"agent/src/shared/rbac-types.ts"})` để tái xác nhận 0 caller (kết quả có thể đã đổi từ lúc audit).
- **Không đụng tới** 3 bản copy còn lại (`backend/src/shared/rbac-types.ts`, `desktop/src/shared/rbac-types.ts` — đang sống thật, thuộc phạm vi "System B" mà CR-RBAC-001 retire; `frontend/src/shared/rbac-types.ts` — xem [FE-SOL-001](../../../../frontend/crs/v4/team-rbac/solutions/FE-SOL-001-drop-lead-from-global-role-model.md) đã giao việc xoá bản này).
- Không tạo file task riêng cho việc này trừ khi có người thật sự lấy vào sprint — ghi chú ở đây là đủ.
