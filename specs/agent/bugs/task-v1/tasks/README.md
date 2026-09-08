# Tasks Index — `agent/` bugs task-v1

Mục lục task thực thi cho 5 bug ở [`specs/agent/bugs/task-v1/`](../README.md),
chia nhỏ từ solution ở [`../solutions/`](../solutions/). Theo đúng kết luận
của [`solutions/README.md`](../solutions/README.md): **chỉ 1/5 bug
(BUG-AGENT-TASKV1-003) có gap thật cần code mới ở `agent/`** — 4 bug còn lại
(001, 002, 004, 005) kết luận "✅ Không cần action bắt buộc ở `agent/`" vì
gap thật nằm ở `backend-go`/`desktop/`, đã được track ở nơi tương ứng.

## Bảng tóm tắt

| Bug | Có task bắt buộc? | Task | Lý do |
|---|---|---|---|
| [BUG-AGENT-TASKV1-001](../BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md) | ❌ Không | [TASK-AGENT-TASKV1-03](./TASK-AGENT-TASKV1-03-execprompt-explicit-taskid-projectid-optional.md) (P3, optional) | Gap thật (`env`/`ORCA_TASK_ID`/`ORCA_PROJECT_ID` injection) nằm ở `backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go` — xem [`SOL-TASKV1-004`](../../../../backend-go/bugs/task-v1/solutions/SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md)/[`SOL-PRF-04`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md). `agent/` đã sẵn sàng nhận `env` qua `params.env` hôm nay. |
| [BUG-AGENT-TASKV1-002](../BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md) | ❌ Không | — | Cả 2 gap đều ở `backend-go`: (1) `orchestration-service` chưa có dispatch loop gọi `infra-fleet-service` — track ở [`BUG-TASKV1-005`](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md); (2) `infra-fleet-service.Relay` (unary) thiếu kênh nhận notification — thiết kế tái dùng `AttachPty`/`StreamPty` đã có ở [`SOL-AG-01`](../../../../backend-go/bugs/logic-v1/solutions/SOL-AG-01-khoi-dong-agent.md). Solution không đề xuất optional nào cho `agent/`. |
| [BUG-AGENT-TASKV1-003](../BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) | ✅ Có — gap thật duy nhất ở `agent/` | [TASK-AGENT-TASKV1-01](./TASK-AGENT-TASKV1-01-agent-execprompt-output-notification.md), [TASK-AGENT-TASKV1-02](./TASK-AGENT-TASKV1-02-shell-exec-output-notification.md) | `agent.execPrompt`/`shell.exec` buffer toàn bộ output, không phát notification giữa chừng — cần code mới, áp dụng đúng Pattern A (`makeNotifier`, giống `pty.data`/`agent.output`) đã chọn trong solution. |
| [BUG-AGENT-TASKV1-004](../BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md) | ❌ Không | — | Gap (`workflow-service.AgentExecutor` gọi `agent.exec` sai shape) 100% ở `backend-go` — **đã có bug + solution + task thực thi đầy đủ** tại [`BUG-PRF-04`](../../../../backend-go/bugs/logic-v1/BUG-PRF-04-profile-aware-agent-execution-not-implemented.md)/[`SOL-PRF-04`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md)/[`TASK-PRF-04-06`](../../../../backend-go/bugs/logic-v1/tasks/TASK-PRF-04-06-workflow-service-agent-executor-env-injection.md). Không phải gap mới, không lặp lại task. Solution không đề xuất optional nào cho `agent/`. |
| [BUG-AGENT-TASKV1-005](../BUG-AGENT-TASKV1-005-agent-vs-desktop-relay-divergence-scoped-to-backend-go.md) | ❌ Không | — | Không có code thay đổi nào được đề xuất trong `agent/` — rủi ro phân kỳ còn lại chỉ áp dụng cho `desktop/` (Node backend), ngoài phạm vi thư mục này. Việc còn lại (tài liệu hoá / quyết định phạm vi sản phẩm / port sang `desktop/`) không phải action ở `agent/`. Solution không đề xuất optional nào cho `agent/`. |

## Danh sách file

1. [`TASK-AGENT-TASKV1-01-agent-execprompt-output-notification.md`](./TASK-AGENT-TASKV1-01-agent-execprompt-output-notification.md)
   — 🟠 P1. Thêm notification `agent.execPrompt.output` cho
   `handleAgentExecPrompt` (`agent-print-mode-exec.ts`), wiring qua
   `makeNotifier(ws, state)` đã có sẵn ở `agent-rpc-dispatch.ts`.
2. [`TASK-AGENT-TASKV1-02-shell-exec-output-notification.md`](./TASK-AGENT-TASKV1-02-shell-exec-output-notification.md)
   — 🟠 P1. Thêm notification `shell.exec.output` cho `handleShellExec`
   (`fs-agent-extensions.ts`); phải luồn thêm `state: WireState` qua
   `dispatchMiscRpc` (hiện chỉ nhận `ws`) — 1 điểm khác solution gốc, xác
   nhận bằng đọc code thật (`makeNotifier` cần cả `ws` và `state`).
3. [`TASK-AGENT-TASKV1-03-execprompt-explicit-taskid-projectid-optional.md`](./TASK-AGENT-TASKV1-03-execprompt-explicit-taskid-projectid-optional.md)
   — 🟢 P3, **optional, không bắt buộc**. Tách `taskId`/`projectId` tường
   minh khỏi `stepId` trong `handleAgentExecPrompt`, giảm rủi ro nhầm lẫn
   field cho backend tương lai. Không chặn fix BUG-AGENT-TASKV1-001 —
   backend-go có thể tự đóng gap qua `params.env` mà không cần task này.

## Vì sao 001, 002, 004, 005 không có task bắt buộc

Theo đúng kết luận đã audit kỹ ở [`../solutions/README.md`](../solutions/README.md):
`agent/` đã cung cấp đủ RPC primitive cho cả 3 hệ nghiệp vụ (OrcaTask, Task
Execute, Workflow Orchestration) — gap còn lại của 4/5 bug này là
**backend-go chưa gọi đúng, chưa gọi, hoặc chưa có hạ tầng nhận streaming**,
không phải `agent/` thiếu khả năng. Tạo task "để làm gì đó" ở `agent/` cho
các bug này sẽ là việc giả — không có gì để sửa trong `agent/src/relay/*.ts`
mà không lặp lại đúng nội dung task đã có sẵn ở phía `backend-go`. Chỉ
BUG-AGENT-TASKV1-001 có 1 đề xuất optional thật sự (không lặp lại nội dung
backend-go, chỉ là refactor phòng ngừa) — 3 bug 002/004/005 không có đề xuất
optional nào trong solution tương ứng.

**Trỏ sang backend-go để theo dõi việc thực thi thật:**
- BUG-AGENT-TASKV1-001 → [`specs/backend-go/bugs/task-v1/BUG-TASKV1-004`](../../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) + [`SOL-TASKV1-004`](../../../../backend-go/bugs/task-v1/solutions/SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md) + [`TASK-TG-04-06`](../../../../backend-go/bugs/logic-v1/tasks/TASK-TG-04-06-context-preamble-env-injection.md) + [`TASK-PRF-04-08`](../../../../backend-go/bugs/logic-v1/tasks/TASK-PRF-04-08-task-service-simple-executor-env-injection.md).
- BUG-AGENT-TASKV1-002 → [`specs/backend-go/bugs/task-v1/BUG-TASKV1-005`](../../../../backend-go/bugs/task-v1/BUG-TASKV1-005-task-execute-orchestration-coordinator-not-autonomous.md) (chưa có solution tại thời điểm audit) + [`specs/backend-go/bugs/logic-v1/BUG-AG-01`](../../../../backend-go/bugs/logic-v1/BUG-AG-01-khoi-dong-agent-partial.md)/[`SOL-AG-01`](../../../../backend-go/bugs/logic-v1/solutions/SOL-AG-01-khoi-dong-agent.md) (Status PARTIAL).
- BUG-AGENT-TASKV1-004 → [`specs/backend-go/bugs/logic-v1/BUG-PRF-04`](../../../../backend-go/bugs/logic-v1/BUG-PRF-04-profile-aware-agent-execution-not-implemented.md)/[`SOL-PRF-04`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md)/[`TASK-PRF-04-06`](../../../../backend-go/bugs/logic-v1/tasks/TASK-PRF-04-06-workflow-service-agent-executor-env-injection.md) — đã có task thực thi đầy đủ.
- BUG-AGENT-TASKV1-005 → không có bug/task backend-go tương ứng (kết luận là quyết định phạm vi sản phẩm + việc tài liệu hoá, không phải 1 gap kỹ thuật cần track).

## Thứ tự triển khai khuyến nghị cho TASK-AGENT-TASKV1-01/02

Giá trị thực tế của 2 task này phụ thuộc vào hạ tầng nhận ở backend-go (xem
[SOL-AGENT-TASKV1-002](../solutions/SOL-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md)'s
Việc 1) và việc `workflow-service` phải dùng đúng `agent.execPrompt` trước
(BUG-AGENT-TASKV1-004). Thứ tự khuyến nghị theo `SOL-AGENT-TASKV1-003`:

1. Backend-go: sửa `workflow-service.AgentExecutor` dùng đúng `agent.execPrompt`.
2. Backend-go: `infra-fleet-service` mở kênh nhận notification qua `AttachPty`.
3. `agent/` (2 task ở đây): thêm `notify` callback cho `handleAgentExecPrompt`/`handleShellExec`.
4. Backend-go: nối `agent.execPrompt.output`/`shell.exec.output` vào outbox Activity Feed.

TASK-AGENT-TASKV1-01/02 có thể implement độc lập (không phụ thuộc bước 1-2
đã hoàn tất) — chỉ *phát huy tác dụng* sau khi backend-go xong phần của họ.

## Tham khảo

- [`../README.md`](../README.md) — bug index gốc.
- [`../solutions/README.md`](../solutions/README.md) — solution index, kết luận phân loại 5 bug.
- [`specs/backend-go/bugs/task-v1/`](../../../../backend-go/bugs/task-v1/), [`specs/backend-go/bugs/logic-v1/`](../../../../backend-go/bugs/logic-v1/) — task/solution backend-go tương ứng.
