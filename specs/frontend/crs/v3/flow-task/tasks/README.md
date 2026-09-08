# Tasks — CR-FLOW-TASK (frontend)

Task thực thi cho [FE-SOL-001](../solutions/FE-SOL-001-unified-task-execution-ui.md)
(CR-FLOW-TASK-005), chia theo đúng 5 mảng solution đã thiết kế.

| Task ID | Mô tả | Phụ thuộc |
|---------|-------|-----------|
| [FE-TASK-001](./FE-TASK-001-execution-engine-badge.md) | `ExecutionEngineBadge` — badge suy luận Engine phía client (`direct_agent`/`orchestration`/`workflow`), thêm `OrcaTask.workflowTemplateId?` | Không có |
| [FE-TASK-002](./FE-TASK-002-attach-workflow-template-action.md) | `AttachWorkflowTemplateAction` — dropdown `workflow.template.list`, attach template vào task (⚠️ optimistic-only, `UpdateTaskRequest` backend chưa có field để lưu bền) | FE-TASK-001 |
| [FE-TASK-003](./FE-TASK-003-use-task-activity-polling-fallback.md) | `useTaskActivity` — polling `task.get` fallback thay theo dõi im lặng sau Run (⚠️ hard blocker: `subscribeRuntimeEvent` không tồn tại, CR-FLOW-TASK-003 chưa triển khai) | Không có (khuyến nghị làm sau FE-TASK-001/002 để tránh conflict merge trên `TaskDetail.tsx`) |
| [FE-TASK-004](./FE-TASK-004-fix-run-workflow-rpc-shape.md) | Sửa `useWorkflow.ts`'s `runWorkflow()` đúng shape `workflow.execute` thật (`rootTraceId`/`requestId`, bỏ `inputs`), cập nhật call site `WorkflowBuilder.tsx` | Không có |
| [FE-TASK-005](./FE-TASK-005-fix-save-template-update-rpc-shape.md) | Sửa `useWorkflow.ts`'s `saveTemplate()` nhánh update đúng shape `workflow.template.update` thật (`id`/`dagJson`/`expectedVersion`) | Không có (khuyến nghị làm nối tiếp FE-TASK-004 — cùng file) |
| [FE-TASK-006](./FE-TASK-006-task-prompt-editor-optional-prompt.md) | `TaskPromptEditor.tsx` — bỏ `disabled={!prompt.trim()}` gây UX nói dối, thêm note tĩnh, gửi `prompt` optimistic (⚠️ hard blocker: `TaskServiceExecuteRequest` proto chưa có field `prompt`, no-op tới khi backend thêm) | Không có |

## Ghi chú thứ tự thực thi

- FE-TASK-001 → FE-TASK-002 là chuỗi cứng (field `workflowTemplateId` + vùng Action Buttons).
- FE-TASK-003 sửa cùng vùng `TaskDetail.tsx` (Action Buttons / `handleRunAgent`) với 001/002 —
  không phải phụ thuộc chức năng, nhưng làm sau cùng giảm xung đột merge.
- FE-TASK-004/005 cùng sửa `useWorkflow.ts` (2 hàm khác nhau: `runWorkflow`/`saveTemplate`) —
  không phụ thuộc chức năng lẫn nhau, khuyến nghị làm nối tiếp cùng 1 PR hoặc 2 PR liền để tránh
  conflict merge trên cùng file.
- FE-TASK-006 độc lập hoàn toàn, có thể làm song song với các task khác.

## Hard blocker cần backend/runtime layer thay đổi trước — tổng hợp

| Task | Blocker | Trạng thái |
|------|---------|-----------|
| FE-TASK-002 | `UpdateTaskRequest` proto (`task.proto:156-160`) không có field `workflow_template_id` → attach chỉ optimistic, mất khi reload | CR-FLOW-TASK-002 — chưa triển khai |
| FE-TASK-003 | `subscribeRuntimeEvent` không tồn tại; kênh WS `task.activity:{taskId}` chưa có; `RuntimeClientEvent` (client) chưa có variant `taskActivity` | CR-FLOW-TASK-003 — 🔵 Proposed, chưa triển khai |
| FE-TASK-006 | `TaskServiceExecuteRequest` proto (`task.proto:124-127`) không có field `prompt` → gửi optimistic nhưng backend bỏ qua, no-op | Chưa có CR/task backend theo dõi việc này — khuyến nghị mở ở `specs/backend-go/bugs/task-v1` |

FE-TASK-001/004/005 **không có hard blocker backend** — cả 3 sửa xong là chức năng hoạt động đầy
đủ ngay (001 là suy luận client-side tự đủ; 004/005 chỉnh đúng theo shape `backend-go` đã tồn tại
sẵn, không cần đổi backend).

## Không thuộc phạm vi các task ở đây

Xem mục "Không làm ở solution này" của [FE-SOL-001](../solutions/FE-SOL-001-unified-task-execution-ui.md)
— cụ thể: không đổi `TaskDAGView.tsx`/access-control UI, không xây dashboard Engine 2
(`OrchestrationPage.tsx`), không tự triển khai `execution_links`/`selectEngine()` phía backend,
không thêm variant `taskActivity` vào `RuntimeClientEvent`/bridge IPC, không sửa
`workflow.template.create`'s payload, không sửa `StepEditor.tsx`/`DAGPreview.tsx`.
