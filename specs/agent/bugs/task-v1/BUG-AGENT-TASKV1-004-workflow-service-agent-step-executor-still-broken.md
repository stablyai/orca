# BUG-AGENT-TASKV1-004: `workflow-service`'s `AgentExecutor` vẫn gọi `agent.exec` sai shape — `task-service`'s tương đương ĐÃ sửa, `workflow-service` THÌ CHƯA; `shell`/`notification`/`webhook` đều ĐÚNG

## Mức độ: 🔴 CRITICAL (mọi workflow step type `agent` chạy qua backend-go sẽ fail `InvalidParams` — kế thừa nguyên trạng bug gốc, chỉ đổi service)

## Tóm tắt

Câu hỏi cần trả lời: `workflow-service`'s step executors
(`agent_step_executor.go`, `shell_step_executor.go`, `webhook.go`) gọi qua
`infra-fleet-service.Relay` xuống `agent/` — agent/ có đủ RPC cho từng step
type không, và còn thiếu gì so với những gì
[BUG-TG-001](../task-graph/BUG-TG-001-relay-missing-agent-exec-handler.md)
đã "fix" (cho backend Node) không?

**Kết luận: 3/4 step type ĐÚNG (`shell`/`notification`/`webhook`), 1/4 SAI
(`agent`)** — và cái sai là chính xác cùng loại lỗi mà
`compliance-audit-2026-08-15.md` §2 phát hiện #1 đã ghi cho backend Node
("`agent.exec` param shape — là bug backend, không phải agent gap") và
backend Node **đã tự sửa** (`StepExecutors.ts` → `agent.execPrompt`,
2026-08-16) — nhưng **`workflow-service` (backend-go) là 1 codebase khác,
viết sau, và lặp lại đúng lỗi đó** dù chính file đó tự trích dẫn
`gaps-and-findings.md`'s "TS Gap 4" trong comment của nó.

## Đối chiếu 4 step type

| Step type | File | Method gọi | Params gửi | Đúng với agent/ handler thật? |
|---|---|---|---|---|
| `agent` | `agent_step_executor.go:22,26-29` | `agent.exec` | `{prompt, worktreePath, trustPreset}` | ❌ **SAI** — `agent.exec` (`agent-rpc-dispatch-agent-exec.ts:72`) chỉ nhận `{binary(required), args?, cwd?, stdin?, env?, timeoutMs?}` — không có `prompt`/`worktreePath`/`trustPreset`. Sẽ fail `InvalidParams` (thiếu `binary`) |
| `shell` | `shell_step_executor.go:17,22-24` | `shell.exec` | `{script, env}` | ✅ ĐÚNG — khớp chính xác `handleShellExec`'s params (`agent-rpc-catalog-runtime.md` dòng 169: `script(required), env?, traceId?, timeoutMs?`) |
| `notification` | `notification_step_executor.go:17,23-24` | `notification.send` | `{channel, message}` | ✅ ĐÚNG — khớp `handleNotificationSend` (dòng 170: `channel?, message(required), traceId?`) |
| `webhook` | `webhook.go` | (không qua agent/, `net/http` trực tiếp) | n/a | ✅ Không áp dụng — đúng theo thiết kế (`workflow-service.md §4/§9`: "step type duy nhất gọi HTTP native") |

## Bằng chứng — `agent_step_executor.go` tự biết mình sai nhưng chưa sửa

```go
// backend-go/services/workflow-service/internal/adapter/infrafleetclient/agent_step_executor.go:12-23
// agentExecMethod is the Relay method name AgentExecutor uses.
//
// Best-effort, not verified against a live Dev Server Agent ... TS's
// StepExecutors.executeAgent() ... found "agent.exec" IS a real agent RPC —
// just a different one: a generic {binary,args,cwd,stdin,env,timeoutMs}
// process-exec call with no prompt/model/trustPreset concept — and had to
// switch to "agent.execPrompt" to carry those fields (see
// specs/agent/api/gaps-and-findings.md, "TS Gap 4"). Reconcile the method
// name against the real agent handler contract before depending on this in
// production.
const agentExecMethod = "agent.exec"

type agentExecParams struct {
    Prompt       string `json:"prompt"`
    WorktreePath string `json:"worktreePath,omitempty"`
    TrustPreset  string `json:"trustPreset,omitempty"`
}
```

Đối chiếu handler thật hôm nay xác nhận đúng như comment tự ghi:

```
agent/src/relay/agent-rpc-dispatch-agent-exec.ts:72   case 'agent.exec': { ... }  // params: {binary, args?, cwd?, stdin?, env?, timeoutMs?}
agent/src/relay/agent-rpc-dispatch-agent-exec.ts:176  case 'agent.execPrompt': { ... }  // params: {prompt, worktreePath, trustPreset?, model?, accountId?, stepId?, env?, timeoutMs?}
```

**`agentExecParams`'s 3 field (`Prompt`/`WorktreePath`/`TrustPreset`) khớp
100% với `agent.execPrompt`'s params, 0% với `agent.exec`'s params.** Đây
không phải "thiếu RPC ở agent/" — RPC đúng (`agent.execPrompt`) đã tồn tại,
hoạt động (xác nhận ở
[BUG-AGENT-TASKV1-001](./BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md),
`task-service.SimpleExecutor` đang dùng thành công) — `workflow-service`
chỉ đơn giản chưa đổi tên method + struct field từ `agentExecParams` sang
đúng shape `agent.execPrompt` cần.

## So sánh 2 service backend-go cùng codebase, cùng ngày, khác kết quả

| | `task-service.SimpleExecutor` | `workflow-service.AgentExecutor` |
|---|---|---|
| Method gọi | `agent.execPrompt` ✅ | `agent.exec` ❌ |
| Có doc comment trích `gaps-and-findings.md` "TS Gap 4"? | Có, và **đã hành động theo đó** | Có, nhưng **chỉ ghi lại làm cảnh báo, chưa hành động** |
| Trạng thái | Đúng, hoạt động | Sai, mọi step `agent` fail `InvalidParams` |

Đây là bằng chứng rõ nhất cho thấy đây **không phải** agent/ thiếu tài
liệu/RPC — cùng 1 nguồn tài liệu (`gaps-and-findings.md`), 1 team đọc và sửa
đúng, 1 team đọc và chỉ ghi chú lại. Việc cần làm là áp dụng lại đúng pattern
`SimpleExecutor` đã chứng minh chạy được, sang `AgentExecutor`.

## Fix đề xuất (mirror `SimpleExecutor`, xem BUG-AGENT-TASKV1-001)

```go
// agent_step_executor.go — đổi:
const agentExecMethod = "agent.execPrompt"

type agentExecParams struct {
    Prompt       string `json:"prompt"`
    WorktreePath string `json:"worktreePath"`
    StepID       string `json:"stepId,omitempty"`
    TrustPreset  string `json:"trustPreset,omitempty"`
    // Cân nhắc thêm Model/AccountId nếu domain.AgentStepConfig có sẵn field
    // tương ứng — SimpleExecutor hiện cũng omit khi không có, theo đúng
    // "omit-when-unresolved" convention StepExecutors.ts (Node) dùng.
}
```

Đồng thời cập nhật `execResult`/response-parsing nếu shape khác — xác nhận
`agent.execPrompt`'s response
(`{stdout, stderr, exitCode, timedOut, stepId?}` —
`agent-print-mode-exec.ts` dòng 25-31) so với `agent.exec`'s response hiện
`AgentExecutor` đang parse qua `toStepResult(result)`/`execResult` type —
cần audit riêng struct `execResult` trong `relay_client.go` để đảm bảo field
`exitCode`/`timedOut` decode đúng (không nằm trong phạm vi audit này, cần 1
task riêng bên `specs/backend-go/`).

## Không phải bug của agent/

Giống hệt phân loại của `compliance-audit-2026-08-15.md` cho phát hiện #1
gốc: đây là bug 100% phía `backend-go` (`workflow-service`), agent/ đã cung
cấp đúng, đủ RPC (`agent.execPrompt`) từ trước. Ghi vào `specs/agent/`
(thay vì `specs/backend-go/`) vì nhiệm vụ audit này yêu cầu xác nhận "agent/
đã cung cấp đủ RPC cho Workflow Orchestration chưa" — câu trả lời là ĐÃ ĐỦ,
và bug này tồn tại chính là bằng chứng cho thấy backend chưa dùng đúng những
gì đã đủ, không phải bằng chứng thiếu RPC.

## Tham khảo

- [`specs/agent/bugs/task-graph/BUG-TG-001-relay-missing-agent-exec-handler.md`](../task-graph/BUG-TG-001-relay-missing-agent-exec-handler.md) — bug gốc (đã fix cho backend Node), `workflow-service` (backend-go) tái phát cùng loại lỗi.
- [`specs/agent/api/compliance-audit-2026-08-15.md`](../../api/compliance-audit-2026-08-15.md) — §2 phát hiện #1, quyết định #6 (2026-08-16, backend Node đã đổi sang `agent.execPrompt`).
- [`specs/agent/crs/v2/full-flow-tracing/solutions/SOL-AG-TRACE-017-workflow-orchestration.md`](../../crs/v2/full-flow-tracing/solutions/SOL-AG-TRACE-017-workflow-orchestration.md) — xác nhận `shell.exec`/`notification.send` từng thiếu ở agent/ (nay đã có, xem bảng đối chiếu trên) và `agent.exec` (bản Node) từng đúng — tài liệu đó viết trước khi backend Node đổi sang `agent.execPrompt`, nay đã lỗi thời ở chi tiết method name nhưng đúng ở cấu trúc phân tích.
- [BUG-AGENT-TASKV1-001](./BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md) — xác nhận `agent.execPrompt` hoạt động đúng qua `task-service.SimpleExecutor`, dùng làm mẫu fix cho bug này.
- [BUG-AGENT-TASKV1-003](./BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md) — SOL-AG-PW-001 §3 liệt kê việc sửa bug này là prerequisite bắt buộc trước khi thiết kế streaming.

## Trích dẫn file:line

- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/agent_step_executor.go:12-31,55-65` — `agentExecMethod`/`agentExecParams`, tự trích `gaps-and-findings.md` "TS Gap 4" nhưng chưa hành động.
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/shell_step_executor.go:12-24,39-51` — `shell.exec`, ĐÚNG shape.
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/notification_step_executor.go:12-24` — `notification.send`, ĐÚNG shape.
- `backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:16-70,157-172` — mẫu đã sửa đúng, dùng để đối chiếu fix.
- `agent/src/relay/agent-rpc-dispatch-agent-exec.ts:72,176` — 2 handler thật, xác nhận shape khác nhau.
