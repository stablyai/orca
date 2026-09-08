# CR-FLOW-TASK-001 — Mô hình thống nhất: Task chạy qua 1 trong 3 Execution Engine

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-FLOW-TASK-001 |
| **Tên** | Thống nhất OrcaTask / Task Execute (orchestration-service) / Workflow Orchestration dưới 1 mô hình "3 execution engine" |
| **Loại** | Architecture |
| **Priority** | 🔴 P0 — nền tảng cho toàn bộ series `flow-task` |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔵 Proposed — chưa triển khai |
| **Phụ thuộc** | Không (là CR nền tảng); Engine 2 dựa trên thiết kế đã có sẵn ở [SOL-TG-04](../../../../specs/backend-go/bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md) |
| **Tác động** | `backend-go/services/task-service` (usecase/domain), `backend-go/proto/orca/task/v1/task.proto`; không đổi `orchestration-service`/`workflow-service` (CR này chỉ đặt tên/hợp nhất, không đổi API của chúng) |

---

## Bối cảnh & Vấn đề

Khảo sát 3 hệ Task trong `backend-go` cho thấy chúng tồn tại **độc lập, không cùng vocabulary**:

| | OrcaTask (`task-service`) | Task Execute (`orchestration-service`) | Workflow Orchestration (`workflow-service`) |
|---|---|---|---|
| Vai trò | Kanban DAG, grant, comment — user-facing | Điều phối multi-agent lead/worker cho 1 subtree phức tạp | Pipeline nhiều bước dạng DAG, đa dev-server |
| Trigger hiện tại | `task.execute` (user bấm "Run") | Chỉ được gọi **nội bộ** từ `task-service`'s `ComplexExecutor` — hiện là **stub trả chuỗi giả** (`complex_executor.go:24-26`) | `workflow.execute` (user chọn template, bấm "Run") — **không có đường nào từ 1 Task gọi tới** |
| Trạng thái | 4 status: open/in_progress/done/cancelled | 6 status: pending/ready/dispatched/completed/failed/blocked | executions.status riêng, step_executions riêng |

`task-service.md` §3.1 (TDD) đã đặc tả đúng ý định: `ExecuteTask` phải chọn
giữa **simple** (gọi thẳng agent qua `infra-fleet-service`) và **complex**
(giao cho `orchestration-service`'s coordinator) — đây là **2 trong 3
engine**. Nhưng **không tài liệu backend-go nào (TDD, SOL-TG-04, SOL-PW-04)
nhắc tới Workflow Orchestration như một lựa chọn thứ 3** để chạy 1 Task —
đây là engine duy nhất chưa có chỗ đứng trong kiến trúc, và là trọng tâm của
[CR-FLOW-TASK-002](./CR-FLOW-TASK-002-workflow-as-task-execution-engine.md).

Hệ quả của việc thiếu 1 mô hình chung: frontend phải biết chi tiết implementation
của từng engine (xem `specs/frontend/bugs/task-v1`), UI "Run" hiện chỉ gọi được
`task.execute` (Engine 1/2 gộp chung, vô hình với người dùng) và không có cách
nào chạy Engine 3 từ Task; mỗi engine báo kết quả theo cơ chế riêng (xem
[CR-FLOW-TASK-003](./CR-FLOW-TASK-003-unified-task-activity-event-catalog.md)).

## Giải pháp đề xuất

### 1. Đặt tên chính thức: 3 Execution Engine

```go
// backend-go/services/task-service/internal/domain/execution_engine.go (mới)
type ExecutionEngine string

const (
    EngineDirectAgent   ExecutionEngine = "direct_agent"   // Engine 1 — SimpleExecutor, đã có
    EngineOrchestration ExecutionEngine = "orchestration"  // Engine 2 — ComplexExecutor → orchestration-service, thiết kế đã có ở SOL-TG-04, CHƯA implement (stub)
    EngineWorkflow      ExecutionEngine = "workflow"        // Engine 3 — MỚI, xem CR-FLOW-TASK-002
)
```

Đây **không phải RPC mới** — chỉ là đặt tên chính thức cho nhánh rẽ đã tồn tại
trong `ExecuteTask.Execute` (`execute_task.go:80-94`, xác nhận thật và có unit
test theo BUG-TG-04), cộng thêm nhánh thứ 3. Không đổi hành vi Engine 1/2.

### 2. Bảng liên kết logic — `task.execution_links`

`task-service.md` §3.1 đã sketch cột `active_execution_id` (logical FK, không
FK vật lý — 2 service khác database). CR này cụ thể hóa thành 1 bảng thay vì
1 cột đơn, để hỗ trợ được cả lịch sử (task có thể chạy lại nhiều lần) và cả
3 engine bằng cùng 1 shape:

```sql
-- backend-go/services/task-service/migrations/NNNN_execution_links.up.sql
CREATE TABLE task.execution_links (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    task_id           UUID NOT NULL REFERENCES task.tasks(id),
    engine            TEXT NOT NULL CHECK (engine IN ('direct_agent','orchestration','workflow')),
    external_ref_id   TEXT NOT NULL,   -- coordinator_run_id (Engine 2) hoặc workflow execution_id (Engine 3); rỗng cho Engine 1 (đồng bộ, không có ref)
    status_mirror     TEXT NOT NULL DEFAULT 'in_progress', -- cập nhật bởi CR-FLOW-TASK-003's consumer
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON task.execution_links (task_id, started_at DESC);
```

`task.tasks` giữ 1 con trỏ `active_execution_link_id` (nullable) trỏ tới bản
ghi đang chạy — thay cho việc mỗi engine tự nghĩ ra 1 cột riêng
(`active_execution_id` như SOL-TG-04 sketch chỉ đủ cho Engine 2). Khi
`ReportTaskExecutionResult` (Engine 2, theo SOL-TG-04) hoặc callback tương
đương của Engine 3 ([CR-FLOW-TASK-002](./CR-FLOW-TASK-002-workflow-as-task-execution-engine.md))
báo kết quả, `execution_links.status_mirror` + `completed_at` được cập nhật
trong cùng transaction với `task.tasks.status`.

### 3. `ExecuteTask` — nhánh rẽ 3 chiều

```go
func (uc *ExecuteTask) selectEngine(ctx context.Context, task domain.Task) (ExecutionEngine, error) {
    if task.WorkflowTemplateID != "" { // CR-FLOW-TASK-002
        return EngineWorkflow, nil
    }
    hasSubtree, err := uc.edges.HasChildren(ctx, task.ID) // logic hiện tại của isComplex(), không đổi
    if err != nil { return "", err }
    if hasSubtree {
        return EngineOrchestration, nil
    }
    return EngineDirectAgent, nil
}
```

Ưu tiên: `workflow_template_id` được set tường minh (người dùng chủ động chọn
"chạy bằng workflow này") luôn thắng nhánh complex/simple tự động — tránh nhập
nhằng khi 1 task vừa có subtask vừa có workflow gắn kèm.

## Rủi ro / Lưu ý

- **Không đổi hành vi Engine 1/2 hiện có** — CR này chỉ đặt tên + thêm bảng
  ghi log, không sửa `SimpleExecutor`/`ComplexExecutor`'s logic (việc hoàn
  thiện Engine 2 là phạm vi của SOL-TG-04, không lặp lại ở đây).
- `execution_links` là bảng **thêm mới**, không thay thế `active_execution_id`
  nếu SOL-TG-04 đã triển khai cột đó trước — cần 1 migration hòa giải
  (backfill từ cột cũ sang bảng mới) nếu thứ tự triển khai là SOL-TG-04 trước
  CR-001.
- Đây là CR kiến trúc thuần túy — không có UI đi kèm; UI tiêu thụ mô hình này
  ở [CR-FLOW-TASK-005](./CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md).

## Acceptance Criteria

- [ ] `ExecutionEngine` type + `selectEngine()` tồn tại trong `task-service`, có unit test cho cả 3 nhánh (bao gồm trường hợp vừa có subtree vừa có `workflow_template_id`).
- [ ] Bảng `task.execution_links` tồn tại qua migration, `task.tasks.active_execution_link_id` trỏ đúng bản ghi đang chạy.
- [ ] `ExecuteTask.Execute` ghi 1 dòng `execution_links` cho mỗi lần chạy (kể cả Engine 1 — dù đồng bộ, vẫn cần lịch sử cho Activity Feed ở CR-003).
- [ ] Không có regression trên test hiện có của `execute_task_test.go` (nhánh simple/complex giữ nguyên hành vi).
- [ ] `gitnexus impact --target ExecuteTask` chạy trước khi implement, risk level được ghi lại trong PR.
