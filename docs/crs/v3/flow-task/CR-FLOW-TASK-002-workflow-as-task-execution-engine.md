# CR-FLOW-TASK-002 — Workflow Orchestration làm Execution Engine thứ 3 của Task

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-FLOW-TASK-002 |
| **Tên** | Cho phép 1 OrcaTask chạy bằng cách kích hoạt 1 Workflow Template (Engine 3) |
| **Loại** | Feature / Architecture |
| **Priority** | 🟠 P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔵 Proposed — chưa triển khai |
| **Phụ thuộc** | [CR-FLOW-TASK-001](./CR-FLOW-TASK-001-three-engine-execution-architecture.md) (mô hình `ExecutionEngine`/`execution_links`) |
| **Tác động** | `backend-go/proto/orca/task/v1/task.proto`, `backend-go/proto/orca/workflow/v1/workflow.proto`, `task-service/internal/usecase/execute_task.go`, `workflow-service/internal/usecase/execute.go`, `task-service/internal/adapter/grpcclient/` (new `workflow_executor.go`) |

---

## Bối cảnh & Vấn đề

Không có tài liệu backend-go nào (TDD, ADR, SOL-TG-04, SOL-PW-04) mô tả 1 Task
có thể chạy bằng cách kích hoạt 1 Workflow Template. Hai hệ hoàn toàn tách rời:

- `task-service.md` §3.1 chỉ mô tả 2 nhánh dispatch: simple (direct agent) và
  complex (orchestration-service).
- `workflow-service` chỉ nhận `templateId` trực tiếp qua `workflow.execute` —
  không có `taskId` trong `ExecuteRequest` (`workflow.proto`), không có
  callback nào về `task-service`.

Trong khi đó, về mặt nghiệp vụ (`docs/features/F37-task-graph-management.md`),
một Task hoàn toàn có thể tương ứng 1-1 với 1 quy trình nhiều bước đã được
chuẩn hoá thành template (ví dụ "task sửa bug" → chạy workflow
`bugfix-standard` gồm step reproduce→fix→test→PR) thay vì phải AI-decompose
lại từ đầu mỗi lần.

## Giải pháp đề xuất

### 1. `task.proto` — thêm `workflow_template_id`

```protobuf
message Task {
  // ... các field hiện có + field SOL-PW-04/SOL-TG-04 đã đề xuất ...
  // Khi set, ExecuteTask chọn Engine 3 (CR-FLOW-TASK-001's selectEngine),
  // bỏ qua nhánh simple/complex tự động. Rỗng = hành vi hiện tại, không đổi.
  string workflow_template_id = 10;
}
```

### 2. `workflow.proto` — `ExecuteRequest` mang theo `origin_task_id`

```protobuf
message ExecuteRequest {
  string template_id = 1;
  google.protobuf.Struct inputs = 2;
  string trace_id = 3;
  // MỚI — logical FK ngược về task-service, KHÔNG phải FK vật lý (khác
  // database, giống nguyên tắc id-space-riêng mà orchestration-service.md
  // §2.1 đã áp dụng cho task-service/orchestration-service).
  string origin_task_id = 4;
}
```

`origin_task_id` được lưu trên `workflow.executions` (cột mới, nullable —
NULL nếu workflow được chạy độc lập, không qua Task) để callback (§4) biết
báo kết quả về đâu, và để CR-FLOW-TASK-003's event catalog gắn tag đúng.

### 3. `task-service` — `WorkflowExecutor` (song song `SimpleExecutor`/`ComplexExecutor`)

```go
// internal/adapter/grpcclient/workflow_executor.go (mới)
type WorkflowExecutor struct {
    workflow workflowv1.WorkflowServiceClient
    tasks    usecase.TaskRepository
}

func (w *WorkflowExecutor) Execute(ctx context.Context, tenantID, taskID, requestID string, task domain.Task) (string, error) {
    resp, err := w.workflow.Execute(ctx, &workflowv1.ExecuteRequest{
        TemplateId:   task.WorkflowTemplateID,
        OriginTaskId: taskID,
        // inputs: map task.title/description/aiContext vào workflow inputs
        // theo cùng quy ước {{feature_description}} mà BUG-WF-02 đã ghi nhận
        // workflow-service chưa hỗ trợ interpolation — nếu SOL-WF-02 (đã có
        // ở logic-v1/solutions) chưa implement, inputs rỗng, không chặn CR này.
    })
    if err != nil { return "", fmt.Errorf("workflow_executor: execute: %w", err) }
    return resp.GetExecutionId(), nil // ghi vào execution_links.external_ref_id (CR-001)
}
```

`ExecuteTask.Execute` (CR-001's `selectEngine` trả `EngineWorkflow`) gọi
executor này thay vì `simple`/`complex`, ghi `execution_links` với
`engine='workflow'`, trả `Async: true` giống hệt nhánh complex (workflow
execution cũng không đồng bộ — wave dispatcher chạy nền, theo
`wave_dispatcher.go` đã xác nhận).

### 4. Callback — `workflow-service` báo kết quả về `task-service`

Mẫu y hệt SOL-TG-04's `ReportTaskExecutionResult` (không phát minh cơ chế mới):

```protobuf
// task.proto — RPC service-to-service, orchestration-service đã có RPC tương tự
rpc ReportTaskExecutionResult(ReportTaskExecutionResultRequest) returns (google.protobuf.Empty);
// (nếu SOL-TG-04 đã thêm RPC này cho Engine 2, Engine 3 TÁI SỬ DỤNG cùng RPC —
// request thêm field `engine` để usecase phân biệt log nguồn, KHÔNG tạo RPC riêng)
```

`workflow-service`'s wave dispatcher, tại điểm `executions.status` chuyển
sang trạng thái cuối (`execute.go`'s `runToCompletion`, đã xác định qua
TASK-PW-04-06), gọi thêm 1 bước: nếu `execution.origin_task_id != ""`, gọi
`task-service.ReportTaskExecutionResult`. Đây là điểm mở rộng **bổ sung**
vào đúng chỗ TASK-PW-04-06 đã định vị để publish
`workflow.execution.completed` — cùng 1 transaction, 2 side-effect (publish
event cho SOL-PW-04 + gọi callback cho CR này), không xung đột.

## Rủi ro / Không thuộc phạm vi

- Không giải quyết thiếu sót của Engine 3 tự thân (interpolation, server
  resolution `project:/server:/fleet:tag:`, step type `action`/`parallel` —
  xem `BUG-WF-02` / `specs/backend-go/bugs/task-v1`). CR này chỉ nối dây, không
  sửa Workflow Orchestration nội tại.
- Vòng lặp giả định: 1 workflow template không được phép tự tạo ra 1 task mới
  rồi trỏ `workflow_template_id` về chính nó — CR này không thiết kế cycle
  detection cho trường hợp này vì template hiện không có khả năng tạo Task
  (`workflow-service` không có quyền gọi `task-service.CreateTask`); nếu
  tương lai thêm step type gọi ngược `task.create`, cần bổ sung guard riêng.

## Acceptance Criteria

- [ ] `task.workflow_template_id`, `workflow.executions.origin_task_id` tồn tại qua migration, additive-only (không phá schema hiện có).
- [ ] `ExecuteTask` với `workflow_template_id` được set → gọi đúng `WorkflowExecutor`, không rơi vào nhánh simple/complex.
- [ ] `workflow-service` gọi `ReportTaskExecutionResult` đúng 1 lần khi execution kết thúc (thành công hoặc thất bại), idempotent nếu retry (theo staleness-guard pattern của SOL-TG-04).
- [ ] Test: 1 execution KHÔNG có `origin_task_id` (chạy độc lập, không qua Task) không gọi callback — không phá hành vi hiện tại của Workflow Orchestration đứng riêng.
