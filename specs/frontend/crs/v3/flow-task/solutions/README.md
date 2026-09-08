# Solutions — CR-FLOW-TASK (frontend)

Implementation solution cho các CR trong [`docs/crs/v3/flow-task/`](../../../../../docs/crs/v3/flow-task/README.md), phạm vi frontend.

| ID | CR | Tiêu đề | Status |
|----|----|---------|--------|
| [FE-SOL-001](./FE-SOL-001-unified-task-execution-ui.md) | [CR-FLOW-TASK-005](../../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md) | UI "Run" hợp nhất theo 3-engine: `ExecutionEngineBadge`, "Attach Workflow Template", `useTaskActivity`, sửa shape RPC `useWorkflow.ts` theo `backend-go`, field `prompt` tuỳ chọn cho `TaskPromptEditor` | 📋 Proposed — chưa triển khai |

## Bối cảnh

`CR-FLOW-TASK-001`/`003`/`004` là các CR kiến trúc/backend mà `CR-FLOW-TASK-005` (và solution
FE-SOL-001 ở trên) phụ thuộc — không có solution frontend riêng cho chúng vì không có phần việc
frontend nào trong 3 CR đó (xem bảng "Tác động" của từng CR). `FE-SOL-001` trích dẫn lại các CR này
làm ngữ cảnh khi cần, không lặp lại nội dung.

Solution này đóng các bug đã ghi nhận ở [`specs/frontend/bugs/task-v1/`](../../../../bugs/task-v1/README.md):
BUG-FE-TASKV1-004 (mục 1-2), BUG-FE-TASKV1-005, BUG-FE-TASKV1-007 (mục 1), và giảm nhẹ root cause
BUG-FE-TASKV1-008 (Pha 0 của CR-FLOW-TASK-004 — chốt viết RPC contract theo shape `backend-go`).

## Không thuộc phạm vi solutions ở đây

- BUG-FE-TASKV1-001/002/003 (OrcaTask CRUD/dependency graph/access-control UI) — gap chức năng
  riêng, không phải 1 phần của "liên kết 3 engine" theo CR-FLOW-TASK-005's "Rủi ro / Không thuộc
  phạm vi".
- BUG-FE-TASKV1-006 (Engine 2 — Task Execute/Orchestration — không có dashboard vận hành thật) —
  cần 1 CR/feature riêng, ngoài phạm vi CR-FLOW-TASK-005.
