# CR-FLOW-TASK-003 — Event Catalog & Activity Feed hợp nhất cho cả 3 Engine

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-FLOW-TASK-003 |
| **Tên** | Mở rộng outbox/eventbus (nền tảng SOL-PW-04) để phủ Engine 2 + Engine 3, gộp thành 1 kênh Activity Feed theo Task |
| **Loại** | Architecture / Observability |
| **Priority** | 🟠 P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔵 Proposed — chưa triển khai |
| **Phụ thuộc** | [SOL-PW-04](../../../../specs/backend-go/bugs/logic-v1/solutions/SOL-PW-04-workspace-integration-event-bus.md) (đã đặc tả outbox cho Engine 1/3-notification, CR này mở rộng, không thay thế), [CR-FLOW-TASK-002](./CR-FLOW-TASK-002-workflow-as-task-execution-engine.md) (cần `origin_task_id` trên workflow execution) |
| **Tác động** | `orchestration-service` (outbox mới — hiện **chưa dùng** `common/eventbus`/`common/outbox` dù bảng `orchestration.messages` đã tồn tại), `api-gateway/internal/adapter/wscompat/` (kênh WS mới), `task-service` (consumer cập nhật `execution_links.status_mirror`) |

---

## Bối cảnh & Vấn đề

Mỗi engine báo tiến độ theo cách khác nhau, không cái nào đủ cho 1 Activity
Feed thời gian thực:

- **Engine 1** (direct agent): đồng bộ — client biết kết quả ngay khi
  `task.execute` trả về, không cần event.
- **Engine 2** (orchestration): bảng `orchestration.messages` đã có schema đủ
  8 loại (`status/dispatch/worker_done/merge_ready/escalation/handoff/
  decision_gate/heartbeat`, migration `0001_init.up.sql:101-115`) nhưng
  **không RPC/usecase nào ghi hay đọc bảng này** — đã ghi nhận trong chính
  migration's comment: *"No RPC in the current generated proto... touches
  this table yet"*. `orchestration-service` cũng **0 tham chiếu**
  `eventbus`/`outbox` trong toàn bộ code — không publish bất kỳ event nào.
- **Engine 3** (workflow): SOL-PW-04 đã thiết kế publish
  `workflow.execution.completed`/`.failed` (execution-level), nhưng
  **không có step-level event** (`step.output`/`step.completed` — xác nhận
  bởi `BUG-WF-02`: "No live streaming... confirmed absent by grep").

Kết quả: không có cách nào cho frontend biết "Task này đang ở bước nào" nếu
nó chạy qua Engine 2, và chỉ biết "xong/chưa xong" (không biết bước nào) nếu
chạy qua Engine 3.

## Giải pháp đề xuất

### 1. `orchestration-service` — thêm outbox (mẫu y hệt SOL-PW-04, áp dụng cho service thứ 3)

```go
// orchestration-service/internal/usecase/ports.go (mở rộng, cùng shape SOL-PW-04's OutboxStore)
type OutboxStore interface {
    Enqueue(ctx context.Context, tx pgx.Tx, subject string, payload any) error
}
```

Điểm publish: mọi lần `messages` được ghi (hiện bảng chết — CR này là lý do
đầu tiên khiến bảng cần được ghi thật) và mọi lần `UpdateTaskStatusAndPromote`
đổi status 1 `orchestration_task`. Subject mới, theo đúng quy ước
`orca.<service>.<entity>.<event>` (`common/eventbus/eventbus.go`'s doc):

```
orca.orchestration.task.dispatched
orca.orchestration.task.statuschanged      -- pending/ready/dispatched/completed/failed/blocked
orca.orchestration.message.posted          -- 1 trong 8 message_type, kèm dispatch_context_id
orca.orchestration.decision_gate.opened    -- ĐÃ ĐƯỢC notification-service subscribe sẵn (Subjects
                                            -- list, consumer.go:47) nhưng CHƯA BAO GIỜ publish — CR
                                            -- này lấp đúng lỗ hổng "dead subscription" này.
```

### 2. `workflow-service` — thêm step-level event (bổ sung SOL-PW-04's phần execution-level)

```
orca.workflow.step.completed   -- {execution_id, step_id, step_type, status, origin_task_id}
orca.workflow.step.failed
```

Điểm publish: `wave_dispatcher.go` sau mỗi `UpdateStepExecution` — cùng
transaction, không thêm round-trip DB.

### 3. `api-gateway` — kênh WS hợp nhất theo Task

Mở rộng `RegisterWorkspaceEventBridge` (SOL-PW-04 §"api-gateway: two new
pieces") để subscribe thêm 4 subject mới ở trên, lọc theo `origin_task_id`
(Engine 2 dùng `origin_task_id` gốc theo `orchestration_tasks.origin_task_id`
— CR-FLOW-TASK-002/orchestration-service.md §2.1 đã có sẵn field này), gộp
thành 1 frame `task.activity` duy nhất:

```go
type TaskActivityFrame struct {
    TaskID    string
    Engine    string // "direct_agent" | "orchestration" | "workflow" (CR-001's ExecutionEngine)
    EventType string // "status_changed" | "message_posted" | "step_completed" | "decision_gate_opened"
    Payload   json.RawMessage
    OccurredAt time.Time
}
```

Frontend subscribe **1 kênh duy nhất** `task.activity:{taskId}` thay vì biết
chi tiết `orchestration.*`/`workflow.*` riêng — đây là điểm nối trực tiếp
tới [CR-FLOW-TASK-005](./CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md).

### 4. `task-service` — consumer cập nhật `execution_links` (CR-001's bảng)

`task-service` tự subscribe `orca.orchestration.task.statuschanged` +
`orca.workflow.step.completed` (ephemeral, giống notification-service's
pattern) để cập nhật `execution_links.status_mirror` — đây là cách
`task.tasks.status` "nhìn thấy" tiến độ Engine 2/3 mà **không cần** đường
gRPC đồng bộ nào ngoài callback kết thúc (§4 của CR-002) — status giữa
chừng chỉ cần eventual consistency, đúng tinh thần
`orchestration-service.md §2.2`'s bảng so sánh consistency.

## Rủi ro / Không thuộc phạm vi

- **Không giải quyết streaming stdout liên tục** (PTY output real-time) — đã
  bị SOL-TG-04 flag là cần đổi `agent/` + `infra-fleet-service`, ngoài phạm
  vi CR này. CR-003 chỉ hợp nhất các **sự kiện rời rạc** (status/step/message),
  không phải luồng byte liên tục.
- Không tự động suy ra `origin_task_id` cho execution/coordinator-run đã tồn
  tại trước khi CR này triển khai (dữ liệu lịch sử không có event) — chỉ áp
  dụng cho execution mới sau go-live.

## Acceptance Criteria

- [ ] `orchestration-service` publish đủ 4 subject mới, `orchestration.messages` không còn là bảng chết (có ít nhất 1 usecase ghi + đọc).
- [ ] `orca.orchestration.decision_gate.opened` thực sự được publish — `notification-service`'s consumer (đã subscribe sẵn) nhận được sự kiện thật lần đầu tiên (test tích hợp: publish → assert `HandleIncomingEvent` được gọi).
- [ ] `workflow-service` publish `orca.workflow.step.completed/.failed` cho mọi step, gắn đúng `origin_task_id` khi có.
- [ ] `api-gateway` có kênh WS `task.activity:{taskId}` gộp cả 3 engine, test giả lập 1 event mỗi engine → đúng 1 frame mỗi cái tới đúng client đang subscribe đúng `taskId`.
- [ ] `task-service`'s consumer cập nhật `execution_links.status_mirror` trong vòng khoảng thời gian bounded-poll đã dùng ở SOL-PW-04's test plan (không yêu cầu real-time cứng).
