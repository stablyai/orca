# SOL-FE-TASKV1-007 — `useWorkflow.ts`'s `runWorkflow()` thiếu field `definition` bắt buộc

**Bug:** [BUG-FE-TASKV1-007](../BUG-FE-TASKV1-007-workflow-builder-rpc-shape-mismatch.md)
**Loại giải pháp:** A — Pointer (đã giải quyết bởi 1 solution khác)
**Status:** 📋 Proposed — chưa triển khai

---

## Tóm tắt

Phần mục 1 (root cause chính, Critical) của bug này được giải quyết bởi:

> [`specs/frontend/crs/v3/flow-task/solutions/FE-SOL-001-unified-task-execution-ui.md`](../../../../crs/v3/flow-task/solutions/FE-SOL-001-unified-task-execution-ui.md)

FE-SOL-001 sửa `useWorkflow.ts` theo đúng shape `backend-go`'s
`ExecuteRequest` (`template_id`, không `definition`) — theo `CR-FLOW-TASK-005`
mục 3: *"gửi `{templateId, inputs, projectId, traceId, originTaskId}` — bỏ
kỳ vọng field `definition`"*.

**Cập nhật (2026-09-08):** `FE-SOL-001-unified-task-execution-ui.md` đã
được publish và đã xác nhận: `runWorkflow()`/`saveTemplate()` được sửa theo
đúng shape thật của `channels_workflow.go` (không chỉ theo mô tả tóm lược
trong `CR-FLOW-TASK-005` — ví dụ field thật là `rootTraceId` không phải
`traceId`, `updateTemplate` cần `id`/`dagJson`/`expectedVersion` không phải
`templateId`/`definition`). Pointer này coi như đã xác nhận khớp.

## Điểm cần lưu ý: đây là 1 lựa chọn có đánh đổi, không phải "chỉ còn việc nối dây"

Bug gốc BUG-FE-TASKV1-007 đề xuất 2 hướng khác nhau tùy độ khẩn cấp:

1. **Sửa ngay theo shape Node** (`definition`, không `templateId`) — vì
   **production hôm nay chạy Node** (`deploy/prod/docker-compose.yml`), nên
   đây là fix "tính năng dùng được ngay" (xem đề xuất fix #1 của bug gốc).
2. **Dài hạn, chuyển hẳn sang shape `backend-go`** — chỉ AN TOÀN sau khi
   `CR-FLOW-TASK-004` Pha 3 (flip production sang backend-go) hoàn tất.

FE-SOL-001 (theo mô tả CR-FLOW-TASK-005 mà nó hiện thực) chọn **hướng 2**
ngay từ đầu — nghĩa là sau khi FE-SOL-001 merge, `workflow.execute` sẽ **hết
lỗi trên `deploy/dev` (backend-go) nhưng tiếp tục lỗi (hoặc lỗi theo cách
khác) trên `deploy/prod` (Node)** cho tới khi `CR-FLOW-TASK-004` Pha 3 xong.
Đây không phải sai sót của FE-SOL-001 — bản thân `CR-FLOW-TASK-005`'s
Acceptance Criteria đã ghi rõ: *"ghi rõ trong PR rằng lời gọi này sẽ lỗi
trên Node cho tới khi CR-FLOW-TASK-004 Pha 3 hoàn tất — chấp nhận được, vì
Pha 0 đã đóng băng theo hướng backend-go"*.

**Hành động cần làm khi review FE-SOL-001 (không phải việc của solution
này, nhưng phải kiểm tra):**

- Xác nhận PR của FE-SOL-001 có nêu rõ cảnh báo "vẫn lỗi trên Node/production
  hôm nay" như acceptance criteria yêu cầu — nếu không, đây là 1 regression
  thầm lặng (tính năng Run vẫn lỗi, chỉ đổi từ "lỗi 100%" thành "lỗi 100%
  trên 1 deploy target khác").
- Nếu người dùng thật đang chạy production (Node) cần workflow chạy được
  **trước khi** `CR-FLOW-TASK-004` Pha 3 xong, hướng #1 (vá tạm theo shape
  Node) của bug gốc cần được làm **riêng, độc lập với FE-SOL-001** — không
  nằm trong phạm vi CR-FLOW-TASK-005.

## Mục 2, 3 của bug gốc — không thuộc phạm vi FE-SOL-001

- **Mục 2** (`workflow.template.update` thiếu ở Desktop Electron): thuần
  backend Node, không phải việc frontend — theo dõi riêng, không phải phạm
  vi FE-SOL-001 hay solution này.
- **Mục 3** (step type `'notify'`/`'approval'` không khớp backend): không
  được CR-FLOW-TASK-005 nhắc tới — vẫn là 1 gap mở sau khi FE-SOL-001 merge.
  Cần 1 bug/task riêng để thống nhất `WorkflowStepType` giữa
  `shared/workflow-types.ts`, `StepEditor.tsx`, và backend (`backend-go`'s
  `StepType` enum không có `approval`, dùng `notification` không phải
  `notify`).

## Tham khảo

- [BUG-TASKV1-006](../../../../backend-go/bugs/task-v1/BUG-TASKV1-006-workflow-target-resolution-and-step-types-gap.md), [BUG-TASKV1-008](../../../../backend-go/bugs/task-v1/BUG-TASKV1-008-dual-backend-routing-and-postgres-compliance.md)
- [SOL-FE-TASKV1-008](./SOL-FE-TASKV1-008-dual-backend-rpc-contract-drift.md) — root cause tổng hợp
