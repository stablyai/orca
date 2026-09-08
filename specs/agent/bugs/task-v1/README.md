# `agent/` Bug Index — task-v1 (OrcaTask / Task Execute / Workflow Orchestration)

**Ngày audit:** 2026-09-08
**Câu hỏi audit:** `agent/` (Dev Server Agent / Orca Relay) có cung cấp đầy
đủ RPC PRIMITIVE cần thiết để backend (chủ yếu `backend-go`) hiện thực đầy
đủ 3 hệ nghiệp vụ **OrcaTask (Task Graph)**, **Task Execute (orchestration
coordinator)**, và **Workflow Orchestration** hay chưa?

**Phương pháp:** Đọc trực tiếp `agent/src/relay/*.ts` (working tree hiện
tại, bao gồm các file chưa commit) + `backend-go/services/{task-service,
workflow-service,orchestration-service,infra-fleet-service}/` để xác nhận
từng claim bằng code thật — không copy nguyên trạng từ audit cũ
(`specs/agent/api/`, `specs/agent/bugs/{task-graph,agent-orchestration}/`).
Mỗi bug dưới đây **cross-reference** tài liệu cũ liên quan và ghi rõ trạng
thái hiện tại (đã fix / vẫn đúng / đã lỗi thời) thay vì lặp lại nội dung.

## Kết luận tổng quan

**agent/ cung cấp đủ RPC primitive cho cả 3 hệ — vấn đề còn lại gần như
100% nằm ở phía backend-go (chưa gọi đúng, chưa gọi, hoặc chưa có hạ tầng
nhận streaming), không phải ở thiếu khả năng của agent/.** Ngoại lệ duy
nhất là giới hạn thật của agent/ (chỉ hỗ trợ model `claude` cho one-shot
exec — BUG-AGENT-TASKV1-001 mục 5) và việc thiếu 1 RPC streaming mới ở
tầng `infra-fleet-service` (không phải `agent/`) cho `agent.spawn`'s
notification (BUG-AGENT-TASKV1-002/003).

## Bảng tóm tắt theo 3 hệ

| Hệ | RPC cần | Có ở agent/? | Backend-go dùng đúng chưa? | Bug liên quan |
|---|---|---|---|---|
| **OrcaTask** (Run Agent from Task) | `agent.execPrompt` | ✅ Có, đúng, hoạt động | ✅ `task-service.SimpleExecutor` dùng đúng — nhưng thiếu `env`/context injection thực tế (chưa gửi `env` field) | [001](./BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md) |
| **Task Execute** (worker dispatch) | `agent.spawn`/`sendInput`/`output`/`kill` (hoặc `pty.create`+`AttachPty` thay thế) | ✅ Có, đúng (đã fix theo BUG-AG-ORCH-001/002/004/006) | ❌ `orchestration-service` chưa gọi `infra-fleet-service` ở đâu cả; `infra-fleet-service` chưa có RPC streaming nhận `agent.output`/`agent.exited` | [002](./BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md) |
| **Streaming (Activity Feed)** | notification incremental cho `agent.execPrompt`/`shell.exec` | ❌ Chưa có (nhưng pattern đã chứng minh ở `pty.data`/`git.execStream`) | ❌ Không có hạ tầng nhận (Relay là unary) | [003](./BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) |
| **Workflow Orchestration** (step `agent`/`shell`/`notification`/`webhook`) | `agent.execPrompt`/`shell.exec`/`notification.send` + native HTTP | ✅ Cả 3 RPC có, đúng | ⚠️ `shell`/`notification`/`webhook` ĐÚNG; `agent` step vẫn gọi `agent.exec` sai shape (`workflow-service` chưa áp dụng fix mà `task-service` đã áp dụng) | [004](./BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md) |
| **Meta: cấu trúc agent/ vs desktop/** | n/a | ✅ Với backend-go: đã tự-chứa trong `agent/` (mode `--stdio`) | Chỉ còn rủi ro cho Node backend (production hôm nay) qua `desktop/`'s copy chưa đồng bộ | [005](./BUG-AGENT-TASKV1-005-agent-vs-desktop-relay-divergence-scoped-to-backend-go.md) |

## Danh sách file

1. [`BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md`](./BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md) — 🟡 MEDIUM. Xác nhận `agent.execPrompt` (không phải `agent.exec`) là RPC đúng cho OrcaTask Run-Agent, RPC hoạt động đúng; gap còn lại (env/context injection, giới hạn model `claude`-only) chủ yếu ở phía backend-go.
2. [`BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md`](./BUG-AGENT-TASKV1-002-task-execute-worker-dispatch-primitives-unwired.md) — 🔴 CRITICAL. `agent.spawn`/`sendInput`/`kill`/notification đã đúng ở agent/ (đối chiếu BUG-AG-ORCH-001/002/004/006), nhưng chưa có caller (`orchestration-service`) lẫn nơi nhận streaming (`infra-fleet-service`). Đề xuất đường tắt dùng `pty.create`+`AttachPty` đã có sẵn.
3. [`BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md`](./BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) — 🟠 HIGH. Xác nhận CR-FLOW-TASK-003/SOL-AG-PW-001's cảnh báo "thiếu streaming stdout" vẫn đúng; agent/ đã biết cách làm streaming (pty.data/git.execStream) nhưng chưa áp dụng cho agent.execPrompt/shell.exec.
4. [`BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md`](./BUG-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md) — 🔴 CRITICAL. `workflow-service.AgentExecutor` (backend-go) vẫn gọi `agent.exec` sai shape — cùng lỗi `task-service.SimpleExecutor` đã tự sửa (dùng `agent.execPrompt`). `shell`/`notification`/`webhook` step type đều đúng.
5. [`BUG-AGENT-TASKV1-005-agent-vs-desktop-relay-divergence-scoped-to-backend-go.md`](./BUG-AGENT-TASKV1-005-agent-vs-desktop-relay-divergence-scoped-to-backend-go.md) — 🟡 MEDIUM. Cập nhật/thu hẹp phát hiện cấu trúc của `compliance-audit-2026-08-15.md` §1: backend-go's SSH-relay nay tự-chứa trong `agent/` (mode `--stdio`, phát hiện MỚI, chưa có trong tài liệu cũ nào); rủi ro phân kỳ `agent/`↔`desktop/` chỉ còn áp dụng cho Node backend (vẫn production hôm nay theo CR-FLOW-TASK-004).

## Không lặp lại — đã xác nhận trạng thái, không viết bug mới

- [`BUG-TG-001`](../task-graph/BUG-TG-001-relay-missing-agent-exec-handler.md) — ✅ Fix gốc đúng tại thời điểm viết; nay đã được `agent.execPrompt` thay thế cho use case OrcaTask/Workflow (xem 001/004).
- [`BUG-AG-ORCH-001`](../agent-orchestration/BUG-AG-ORCH-001-missing-agent-sendInput-rpc.md) (sendInput), [`-002`](../agent-orchestration/BUG-AG-ORCH-002-agent-kill-uses-sigterm-not-sigkill.md) (SIGTERM/SIGKILL), [`-004`](../agent-orchestration/BUG-AG-ORCH-004-resolveAgentSpec-missing-codex-opencode.md) (codex/opencode) — ✅ tất cả xác nhận ĐÃ FIX bằng code thật (xem bảng trong 002).
- [`BUG-AG-ORCH-005`](../agent-orchestration/BUG-AG-ORCH-005-agent-manager-not-implemented.md) (AgentManager) — ⏸ DEFERRED, ngoài phạm vi agent/ (là trách nhiệm backend theo chính bug đó tự ghi) — không lặp lại, chỉ liên quan gián tiếp tới Task Execute qua cách dispatch được thiết kế.
- [`BUG-AG-ORCH-006`](../agent-orchestration/BUG-AG-ORCH-006-agent-output-stream-handler-missing.md) — ✅ Phần agent-side (JSON-RPC notification, không phải response) ĐÃ FIX; phần "backend nhận" chưa từng tồn tại cho backend-go — audit này bổ sung phân tích mới (002/003) từ góc nhìn backend-go thay vì backend Node.
- [`BUG-AG-ORCH-009`](../agent-orchestration/BUG-AG-ORCH-009-resume-session-not-implemented.md) (resume), [`-010`](../agent-orchestration/BUG-AG-ORCH-010-switch-account-not-implemented.md) (switch account) — ⏸ vẫn DEFERRED theo chính các file đó — nhắc lại ngắn gọn trong 002 làm rủi ro liên đới cho Task Execute, không audit lại từ đầu.

## Tham khảo tài liệu nguồn

- [`specs/agent/api/compliance-audit-2026-08-15.md`](../../api/compliance-audit-2026-08-15.md)
- [`specs/agent/api/agent-rpc-catalog-runtime.md`](../../api/agent-rpc-catalog-runtime.md), [`agent-rpc-catalog-git-fs.md`](../../api/agent-rpc-catalog-git-fs.md)
- [`specs/agent/crs/v2/full-flow-tracing/solutions/SOL-AG-TRACE-017-workflow-orchestration.md`](../../crs/v2/full-flow-tracing/solutions/SOL-AG-TRACE-017-workflow-orchestration.md)
- [`specs/agent/crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md`](../../crs/v3/project-workspace/solutions/SOL-AG-PW-001-execution-progress-reporting-design.md)
- [`docs/crs/v3/flow-task/`](../../../../docs/crs/v3/flow-task/) (CR-FLOW-TASK-001..005)
- [`specs/backend-go/bugs/task-v1/`](../../../backend-go/bugs/task-v1/) (BUG-TASKV1-001..008)
