# Solutions Index — `agent/` bugs task-v1

Mục lục solution cho 5 bug ở
[`specs/agent/bugs/task-v1/`](../README.md). Mỗi solution xác định rõ **gap
thật nằm ở đâu** trước khi đề xuất fix — 3/5 bug có gap chính ở `backend-go`
(không phải `agent/`), 1/5 là gap thật ở `agent/` (cần code mới), 1/5 không
cần action nào.

## Bảng tóm tắt

| Bug | Gap thật ở đâu | Solution | Status |
|---|---|---|---|
| [BUG-AGENT-TASKV1-001](../BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md) — OrcaTask Run-Agent `env`/`taskId`/`projectId` injection | `backend-go` (`task-service.SimpleExecutor` thiếu field `Env`) — đã có thiết kế ở `SOL-TASKV1-004`/`SOL-PRF-04` | [SOL-AGENT-TASKV1-001](./SOL-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md) | ✅ Không cần action ở agent/ (đề xuất 1 field tường minh, tùy chọn) |
| [BUG-AGENT-TASKV1-002](../BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md) — Task Execute worker dispatch chưa nối dây | `backend-go` (`orchestration-service` chưa gọi `infra-fleet-service`; `infra-fleet-service.Relay` là unary, thiếu kênh nhận notification) — Việc 2 đã track ở `BUG-TASKV1-005`; Việc 1 đã có thiết kế tái dùng ở `SOL-AG-01` | [SOL-AGENT-TASKV1-002](./SOL-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md) | ✅ Không cần action ở agent/ |
| [BUG-AGENT-TASKV1-003](../BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) — Streaming output cho Activity Feed | **`agent/`** — `agent.execPrompt`/`shell.exec` buffer toàn bộ, chưa áp dụng pattern notification đã có (`pty.data`/`git.execStream`) | [SOL-AGENT-TASKV1-003](./SOL-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) | 📋 Proposed — chưa triển khai |
| [BUG-AGENT-TASKV1-004](../BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md) — `workflow-service.AgentExecutor` gọi sai `agent.exec` | `backend-go` (`workflow-service`) — **đã có bug + solution + task thực thi đầy đủ** ở `specs/backend-go/bugs/logic-v1/{BUG-PRF-04, SOL-PRF-04, TASK-PRF-04-06}`, không phải gap mới | [SOL-AGENT-TASKV1-004](./SOL-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md) | ✅ Không cần action ở agent/ |
| [BUG-AGENT-TASKV1-005](../BUG-AGENT-TASKV1-005-agent-vs-desktop-relay-divergence-scoped-to-backend-go.md) — `agent/` vs `desktop/` divergence | `desktop/` (Node backend) — backend-go's SSH-relay đã tự-chứa trong `agent/`, không còn vấn đề | [SOL-AGENT-TASKV1-005](./SOL-AGENT-TASKV1-005-agent-vs-desktop-relay-divergence-scoped-to-backend-go.md) | ✅ Không cần action ở agent/ (chỉ ghi chú tài liệu) |

## Điểm chung xuyên suốt cả 5 solution

- **agent/ đã cung cấp đủ RPC primitive** cho cả 3 hệ nghiệp vụ (OrcaTask,
  Task Execute, Workflow Orchestration) — khớp kết luận tổng quan của
  [`../README.md`](../README.md).
- **Duy nhất 1/5 bug (003) cần code mới ở `agent/`** — thêm notification
  streaming cho `agent.execPrompt`/`shell.exec`, tái dùng đúng pattern
  `pty.data`/`agent.output` đã production.
- 3/5 bug (001, 002, 004) có gap chính ở `backend-go`, và **cả 3 đều đã có
  tài liệu bug/solution/task ở phía `backend-go`** (`task-v1` hoặc
  `logic-v1`) — không có gap nào chưa được track cần báo cáo bổ sung. Điểm
  bổ sung quan trọng nhất mà audit gốc (`specs/agent/bugs/task-v1/README.md`)
  chưa cross-reference: bug 004's fix đã tồn tại sẵn dưới
  `bugs/logic-v1/BUG-PRF-04`/`SOL-PRF-04` (khác thư mục do lịch sử audit,
  không phải bị bỏ sót), và bug 002's Gap 2 (streaming RPC cho
  `agent.spawn`) đã có thiết kế cụ thể ở `bugs/logic-v1/SOL-AG-01` (tái dùng
  `AttachPty`/`StreamPty`, không cần RPC mới).
- 1/5 bug (005) không cần action nào trong `agent/` — chỉ là ghi chú phạm
  vi/tài liệu.

## Tham khảo

- [`../README.md`](../README.md) — bug index gốc, kết luận tổng quan audit.
- [`specs/backend-go/bugs/task-v1/`](../../../../backend-go/bugs/task-v1/) — bug index backend-go tương ứng.
- [`specs/backend-go/bugs/logic-v1/`](../../../../backend-go/bugs/logic-v1/) — nguồn thiết kế cho bug 002 (`SOL-AG-01`) và bug 004 (`SOL-PRF-04`).
