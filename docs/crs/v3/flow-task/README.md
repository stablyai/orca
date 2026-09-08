# Flow Task — Change Requests (v3)

> **Bối cảnh:** phát sinh từ yêu cầu "liên kết 3 loại tác vụ (OrcaTask / Task
> Execute / Workflow Orchestration) thành 1 luồng toàn trình". Khảo sát thực
> tế cho thấy phần lớn kiến trúc liên kết **đã được đặc tả sẵn**, chỉ chưa cài
> đặt:
> - `specs/backend-go/tdd/services/task-service.md` §3.1/§7,
>   `orchestration-service.md` §2-3, `workflow-service.md` §5/§7 đã vẽ đúng
>   sơ đồ phụ thuộc `task-service ⇄ orchestration-service` và event
>   `workflow.execution.completed`/`task.task.statuschanged`.
> - [SOL-TG-04](../../../../specs/backend-go/bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md)
>   đã thiết kế chi tiết `StartCoordinatorRun`/`ReportTaskExecutionResult`
>   (task-service ⇄ orchestration-service) — chưa implement.
> - [SOL-PW-04](../../../../specs/backend-go/bugs/logic-v1/solutions/SOL-PW-04-workspace-integration-event-bus.md)
>   đã thiết kế outbox/eventbus cho `task.task.statuschanged` +
>   `workflow.execution.completed` → `notification-service`/`api-gateway` —
>   chưa implement.
>
> Series CR này **không thiết kế lại** 2 solution trên — nó (1) hợp nhất
> chúng thành 1 bức tranh kiến trúc 3-engine duy nhất cho việc "chạy 1 Task",
> (2) thiết kế mảnh thật sự còn thiếu ở mọi nơi đã khảo sát: **Workflow
> Orchestration chưa từng được nhắc tới như 1 execution engine của Task**, và
> (3) thiết kế phần không service nào phụ trách: đưa `backend-go` (Postgres)
> trở thành nguồn sự thật duy nhất thay cho backend Node/SQLite hiện đang
> chạy production, và tầng UI hợp nhất ở frontend.
>
> Các gap triển khai cụ thể (từng RPC/field/usecase còn thiếu) được audit chi
> tiết riêng ở [specs/backend-go/bugs/task-v1](../../../../specs/backend-go/bugs/task-v1/README.md)
> và [specs/frontend/bugs/task-v1](../../../../specs/frontend/bugs/task-v1/README.md)
> — series CR này chỉ tập trung vào **kiến trúc liên kết**, không lặp lại nội
> dung 2 bộ bug đó.

| CR | Vấn đề | Giải pháp | Status |
|----|--------|-----------|--------|
| [CR-FLOW-TASK-001](./CR-FLOW-TASK-001-three-engine-execution-architecture.md) | 3 hệ Task (OrcaTask/Task Execute/Workflow) không có mô hình chung — mỗi hệ có API/state riêng, frontend phải biết chi tiết từng hệ | Mô hình "3 execution engine" thống nhất dưới 1 abstraction ở `task-service` (`ExecutionEngine`, `TaskExecutionLink`) | 🔵 Proposed |
| [CR-FLOW-TASK-002](./CR-FLOW-TASK-002-workflow-as-task-execution-engine.md) | Workflow Orchestration hoàn toàn tách biệt khỏi OrcaTask — không thể chạy 1 workflow template từ 1 task | Thêm `workflow_template_id` vào Task + Engine 3 trong `ExecuteTask`, `workflow-service` gọi callback về `task-service` giống mẫu `ReportTaskExecutionResult` của SOL-TG-04 | 🔵 Proposed |
| [CR-FLOW-TASK-003](./CR-FLOW-TASK-003-unified-task-activity-event-catalog.md) | Mỗi engine báo tiến độ khác nhau (đồng bộ/polling/không có gì) — không có 1 Activity Feed duy nhất cho Task | Mở rộng outbox/eventbus (nền tảng đã có ở SOL-PW-04) sang Engine 2 + Engine 3, `api-gateway` gộp thành 1 kênh WS `task.activity` theo `origin_task_id` | 🔵 Proposed |
| [CR-FLOW-TASK-004](./CR-FLOW-TASK-004-backend-go-cutover-and-node-sqlite-retirement.md) | Production vẫn chạy backend Node/SQLite cho cả 3 hệ; `backend-go` (Postgres) chỉ chạm tới ở dev/staging | Kế hoạch cutover theo pha, cổng nghiệm thu tham chiếu `bugs/task-v1`, dual-read/shadow, retire Node handler | 🔵 Proposed |
| [CR-FLOW-TASK-005](./CR-FLOW-TASK-005-frontend-unified-task-execution-ui.md) | Frontend gọi RPC không nhất quán (có chỗ khớp shape backend-go, có chỗ khớp Node), không có UI cho Engine 2/3, "Run" button chỉ biết Engine 1 | UI "Run" chọn engine qua abstraction CR-001, 1 Activity Feed subscribe kênh hợp nhất CR-003, sửa toàn bộ RPC call theo shape backend-go | 🔵 Proposed |

## Thứ tự thực thi

```
CR-FLOW-TASK-001 (mô hình/vocabulary) → nền tảng cho toàn bộ các CR sau, không tự nó cần code
  ├── SOL-TG-04 (đã có, độc lập) → phải implement trước hoặc song song CR-001 (Engine 2 là 1/3 chân của mô hình)
  ├── CR-FLOW-TASK-002 (Engine 3 — Workflow) → phụ thuộc CR-001's abstraction
  └── CR-FLOW-TASK-003 (event catalog hợp nhất) → phụ thuộc SOL-PW-04 (đã có) + CR-002 (cần event từ Engine 3)
        └── CR-FLOW-TASK-005 (frontend UI) → phụ thuộc CR-003 (cần kênh WS hợp nhất) + CR-004 (cần biết gọi backend nào)
CR-FLOW-TASK-004 (cutover) → độc lập về thiết kế, nhưng ngày "go-live" phải sau khi CR-001..003 + SOL-TG-04/SOL-PW-04 đã implement xong (dùng chính bugs/task-v1 làm cổng nghiệm thu)
```

## Không thuộc phạm vi series này

- Từng field/RPC/usecase còn thiếu trong mỗi hệ riêng lẻ (đã có báo cáo đầy đủ:
  `BUG-TG-01..04`, `BUG-WF-01..03` ở `specs/backend-go/bugs/logic-v1/`, và
  bản tổng hợp theo khung 3-hệ ở `specs/backend-go/bugs/task-v1/`).
- Cơ chế streaming PTY output thời gian thực (SOL-TG-04 đã flag đây là gap
  cần đổi `agent/` + `infra-fleet-service`, ngoài phạm vi backend-go thuần
  túy) — CR-FLOW-TASK-003 chỉ hợp nhất các event *rời rạc* (status/dispatch/
  step completed), không giải quyết streaming stdout liên tục.
- Event-triggered automation (`BUG-AT-03`) — không phải 1 trong 3 hệ Task
  theo phạm vi câu hỏi gốc.
