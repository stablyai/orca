# BUG-AGENT-TASKV1-001: `agent.execPrompt` là RPC đúng cho OrcaTask Run-Agent — nhưng `env`/context injection không hoạt động như SOL-TG-04 giả định, và chỉ hỗ trợ model `claude`

## Mức độ: 🟡 MEDIUM (RPC nền tảng ĐÚNG và HOẠT ĐỘNG — đây là audit xác nhận + tinh chỉnh, không phải "broken hoàn toàn")

## Tóm tắt

Câu hỏi cần trả lời: OrcaTask (Task Graph) "Run Agent from Task" gọi RPC nào
xuống `agent/`, RPC đó có tồn tại/đúng shape không, và claim của
[SOL-TG-04](../../../backend-go/bugs/logic-v1/solutions/SOL-TG-04-task-agent-execution.md)
("context preamble + env-var injection dùng `env` param **đã có sẵn ở
agent/, không cần đổi agent/**" — xem
[BUG-TASKV1-004](../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md)'s
TASK-TG-04-06) có đúng không.

**Kết luận sau khi đọc code thật:** RPC đúng là `agent.execPrompt`
(KHÔNG PHẢI `agent.exec` như [BUG-TG-001](../task-graph/BUG-TG-001-relay-missing-agent-exec-handler.md)/
[SOLUTION-task-graph.md](../task-graph/solutions/SOLUTION-task-graph.md) mô
tả — 2 tài liệu đó đã lỗi thời, xem "Đối chiếu với BUG-TG-001" bên dưới), và
nó **tồn tại, hoạt động đúng, và đã được `task-service`'s `SimpleExecutor`
gọi đúng shape**. Nhưng claim "`env` injection đã có sẵn, không cần đổi
agent/" chỉ đúng **một nửa**: đúng ở tầng hợp đồng RPC (agent.execPrompt CÓ
nhận `env` tuỳ ý), nhưng **sai** ở tầng thực tế — (a) `SimpleExecutor.Execute`
hôm nay không gửi field `env` nào cả, và (b) ngay cả khi gửi, `ORCA_TASK_ID`
mà agent tự set sẽ mang giá trị `stepId`/`requestID`, không phải task ID
thật, và `ORCA_PROJECT_ID` không có đường nào để tới được agent process trừ
khi nhét thủ công vào `env`.

## Xác nhận bằng code thật

### 1. RPC đúng là `agent.execPrompt`, có handler thật

```
agent/src/relay/agent-rpc-dispatch-agent-exec.ts:176   case 'agent.execPrompt': { ... }
agent/src/relay/agent-print-mode-exec.ts:33             export async function handleAgentExecPrompt(...)
```

`agent-print-mode-exec.ts`'s doc comment (dòng 6-11) tự ghi lại chính xác lý
do đổi tên: `StepExecutors.executeAgent()` từng gửi payload dạng
`{prompt, worktreePath, trustPreset, model, accountId}` thẳng vào
`agent.exec`, nhưng `agent.exec` chỉ nhận
`{binary, args, cwd, stdin, env, timeoutMs}` — mọi step type `agent` fail
`InvalidParams`. `agent.execPrompt` là RPC được tạo riêng để nhận đúng shape
domain này.

### 2. `task-service.SimpleExecutor` (OrcaTask Run-Agent's real caller) đã gọi đúng RPC này

```go
// backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:169-172
resp, err := s.relay.Relay(ctx, &infrafleetv1.RelayRequest{
    ConnectionId: connectionID, Method: "agent.execPrompt", ParamsJson: string(paramsJSON),
})
```

File này có một doc comment dài (dòng 16-70) tự ghi lại toàn bộ quá trình
đối chiếu `agent.exec` vs `agent.execPrompt` bằng cách đọc trực tiếp
`agent-rpc-dispatch.ts`/`agent-print-mode-exec.ts` — **đây chính là việc
audit này được yêu cầu làm, và nó đã được backend-go's tác giả tự làm và ghi
lại trước khi tôi xác nhận lại**. Verify: kết luận của comment đó khớp với
những gì đọc trực tiếp `agent-print-mode-exec.ts` cho thấy — không có sai
lệch.

→ **Đối chiếu với BUG-TG-001**: file đó (`specs/agent/bugs/task-graph/BUG-TG-001-...md`,
đánh dấu "✅ RESOLVED 2026-08-01") mô tả fix là thêm `case 'agent.exec'` —
đúng tại thời điểm đó (khi `StepExecutors.ts` — bản Node cũ — còn gọi
`agent.exec`). Nhưng theo `compliance-audit-2026-08-15.md` §2 quyết định #6
(2026-08-16), backend Node's `StepExecutors.ts`/`ProfileAwareAgentSpawner.ts`
**đã đổi sang gọi `agent.execPrompt`** vì `agent.exec` "là RPC thật — nhưng
là RPC khác" (generic process-exec, không phải prompt-driven). `agent.exec`
hôm nay **vẫn tồn tại** trên agent/ (`agent-rpc-dispatch-agent-exec.ts:72`)
nhưng catalog xác nhận "**No live backend caller as of 2026-08-16**"
(`specs/agent/api/agent-rpc-catalog-runtime.md` dòng 90). Với backend-go,
`task-service.SimpleExecutor` xác nhận tiếp: cũng dùng `agent.execPrompt`,
không phải `agent.exec` — nhất quán với hướng đổi của backend Node.
**Kết luận: BUG-TG-001 KHÔNG SAI ở thời điểm viết, nhưng nội dung "fix" của
nó (thêm `agent.exec`) không phải RPC mà OrcaTask/Workflow dùng ngày hôm
nay — chỉ `agent.execPrompt` mới là con đường sống.**

### 3. `env` injection: ĐÚNG ở tầng RPC contract, SAI ở tầng caller thật

`agent-print-mode-exec.ts:44-56`:
```typescript
const extraEnv =
  params.env && typeof params.env === 'object' && !Array.isArray(params.env)
    ? (params.env as Record<string, string>)
    : undefined
```
— nhận `env` tuỳ ý, merge vào `buildAgentEnv()` (dòng 104-116) qua slot
`extraEnv`. Đây là bằng chứng: **agent/ RPC contract đã sẵn sàng nhận bất kỳ
`env` nào backend muốn gửi — không cần sửa gì ở agent/ để "hỗ trợ env"**.

Nhưng `SimpleExecutor.Execute` (`simple_executor.go:157-163`) — caller thật
duy nhất của OrcaTask Run-Agent — xây `paramsJSON` chỉ từ:
```go
type agentExecPromptParams struct {
    Prompt       string `json:"prompt"`
    WorktreePath string `json:"worktreePath"`
    StepID       string `json:"stepId,omitempty"`
}
```
**Không có field `Env` nào cả.** Vậy dù agent/ đã sẵn sàng nhận `env`,
backend-go hôm nay **không gửi** — task-scoped env vars (`ORCA_TASK_ID`/
`ORCA_PROJECT_ID`) như BL-TG-04/SOL-TG-04 mô tả **không tới được** agent
process qua đường Run-Agent hiện tại.

### 4. Ngay cả khi backend gửi `env`, `ORCA_TASK_ID` cơ sở (không qua `env`) cũng sai giá trị

`agent-print-mode-exec.ts:104-113`:
```typescript
env = await buildAgentEnv(
  { accountId, userId: '', taskId: stepId ?? '', cwd: worktreePath, model: modelId, extraEnv },
  spec, config, null, log, span.id
)
```
`buildAgentEnv` (`agent-spawner.ts:381`) set `ORCA_TASK_ID: taskId` — nhưng
`taskId` ở đây được gán từ `stepId` (params field), **không phải** một field
`taskId` riêng. `SimpleExecutor` gửi `StepID: requestID` (dòng 157 —
biến `requestID` là execution-request id, không phải `task.ID` miền
nghiệp vụ — `task.ID` chỉ dùng để `s.tasks.Get(ctx, tenantID, taskID)` load
task, không bao giờ được đưa vào params gửi cho agent). Kết quả: agent
process nhận được **`ORCA_TASK_ID=<requestID>`**, không phải task ID thật
mà BL-TG-04 mô tả agent CLI nên biết để tự tra cứu task context.

`ORCA_PROJECT_ID` còn tệ hơn: `buildAgentEnv` chỉ set field này nếu
`req.projectId` có giá trị (`agent-spawner.ts:383`,
`...(projectId ? { ORCA_PROJECT_ID: projectId } : {})`), nhưng
`agent-print-mode-exec.ts`'s lời gọi `buildAgentEnv(...)` **không hề set
`projectId`** trong object literal truyền vào (chỉ có
`accountId, userId, taskId, cwd, model, extraEnv`). Vậy `ORCA_PROJECT_ID`
**không bao giờ** được set qua nhánh cơ sở của `agent.execPrompt` — chỉ có
thể tới được agent process nếu backend tự nhét `ORCA_PROJECT_ID` vào
`params.env` (nhánh `extraEnv`, mục 3 ở trên) — mà `SimpleExecutor` hôm nay
không gửi `env` gì cả (mục 3).

### 5. Giới hạn model — chỉ `claude` được hỗ trợ cho one-shot exec

`agent-print-mode-exec.ts:76-94`:
```typescript
if (!spec || spec.binary !== 'claude') {
  span.fail('unsupported model for one-shot exec', { modelId })
  return { ..., error: { code: AgentErrorCode.InvalidParams,
    message: `agent.execPrompt: model "${modelId}" is not supported ... UNSUPPORTED_MODEL_FOR_ONE_SHOT_EXEC` } }
}
```
Nếu 1 project/task được cấu hình dùng `gemini`/`codex`/`opencode` (đều có
trong `AGENT_SPECS`, `agent-spawner.ts:243-291`, dùng được cho `agent.spawn`
interactive) thì OrcaTask Run-Agent (one-shot, `agent.execPrompt`) sẽ luôn
fail `InvalidParams` — đây là giới hạn có chủ đích (comment: "chỉ claude's
`--print`" là "unverified even for the existing *interactive* PTY path" đối
với các binary khác), nhưng là **giới hạn khả năng thật của agent/**, không
phải bug backend-go có thể tự vá — cần agent/ thêm print-mode flag đã verify
cho từng binary trước khi OrcaTask hỗ trợ đa-model cho Run-Agent.

### 6. Timeout: `MAX_TIMEOUT_MS = 15 phút` (`agent-print-mode-exec.ts:22`), unary/blocking

Cả RPC chờ đến khi CLI process thoát hoặc timeout mới trả response — không
có tiến độ giữa chừng. Cross-ref
[BUG-AGENT-TASKV1-003](./BUG-AGENT-TASKV1-003-streaming-output-gap-for-activity-feed.md)
cho phần streaming; ở đây chỉ ghi nhận: nếu 1 tác vụ AI thật sự cần >15
phút, `SimpleExecutor` sẽ nhận `TimedOut` và trả lỗi
`TASK_EXECUTE_TIMED_OUT` (`simple_executor.go:174-176`) dù agent CLI có thể
vẫn đang chạy hữu ích — không có cách gia hạn/heartbeat.

## Ảnh hưởng

1. Task context (title/description/`aiContext`/parent/dependency) không tới
   agent qua env — đây là gap ĐÃ ĐƯỢC `BUG-TASKV1-004` ghi nhận ở phía
   `buildExecutePrompt` (chỉ gửi bare title trong `prompt` text, không dùng
   `env` gì cả) — audit này bổ sung thêm: **kể cả khi backend-go bổ sung
   field vào `prompt`, các biến môi trường chuẩn hoá `ORCA_TASK_ID`/
   `ORCA_PROJECT_ID` mà 1 agent CLI có thể tự đọc (thay vì phải parse prompt
   text) sẽ vẫn sai/thiếu trừ khi sửa CẢ 2 phía**: `SimpleExecutor` (thêm
   field `env`/`projectId` vào request) VÀ `agent-print-mode-exec.ts` (đọc
   `params.taskId`/`params.projectId` tường minh thay vì chỉ suy ra
   `ORCA_TASK_ID` từ `stepId`).
2. Task pin model khác `claude` → Run Agent luôn fail — cần xác nhận với
   product xem có task nào thực tế pin non-claude model chưa (nếu OrcaTask
   UI chưa cho chọn model, đây là rủi ro tiềm ẩn chứ chưa phải bug đang xảy
   ra).

## Không phải bug của agent/ — việc cần làm nằm ở backend-go

Giống cách `compliance-audit-2026-08-15.md` phân loại phát hiện #1 của nó
("`agent.exec` param shape — là bug backend, không phải agent gap"), mục 3+4
ở trên **là gap phía `task-service`**, không phải phía `agent/`: agent/ đã
cung cấp đúng, đủ primitive (`env` passthrough tại `agent.execPrompt`) —
backend-go chỉ cần dùng nó. Ghi vào đây (thay vì `specs/backend-go/`) vì đây
là điểm mà tài liệu hiện có (SOL-TG-04) **khẳng định sai** "agent/ đã đủ,
không cần đổi gì" theo nghĩa **hoàn chỉnh** — đúng ở mức "RPC hỗ trợ", sai ở
mức "hoạt động đầu-cuối" nếu không đồng thời sửa `simple_executor.go`.

## Đề xuất

- **agent/**: không cần thay đổi RPC contract. Cân nhắc (không bắt buộc):
  cho `agent.execPrompt` nhận `taskId`/`projectId` như field tường minh
  riêng (giống `agent.spawn`'s `AgentSpawnRequest`) thay vì chỉ suy luận
  `ORCA_TASK_ID` từ `stepId` — giảm rủi ro nhầm lẫn "task ID" với
  "request ID" cho bất kỳ backend nào dùng RPC này trong tương lai.
- **backend-go** (`simple_executor.go`): thêm `Env map[string]string` vào
  `agentExecPromptParams`, set `ORCA_TASK_ID: taskID` (task ID thật, không
  phải requestID) + `ORCA_PROJECT_ID: task.ProjectID` — theo đúng thiết kế
  TASK-TG-04-06 đã có sẵn.

## Tham khảo

- [`specs/agent/api/agent-rpc-catalog-runtime.md`](../../api/agent-rpc-catalog-runtime.md) — bảng `agent.*`/`ai.*`, dòng `agent.execPrompt`.
- [`specs/agent/api/compliance-audit-2026-08-15.md`](../../api/compliance-audit-2026-08-15.md) — §2 quyết định #6 (chuyển `StepExecutors.ts` sang `agent.execPrompt`, 2026-08-16).
- [`specs/agent/bugs/task-graph/BUG-TG-001-relay-missing-agent-exec-handler.md`](../task-graph/BUG-TG-001-relay-missing-agent-exec-handler.md) — fix gốc cho `agent.exec`, nay đã bị `agent.execPrompt` thay thế cho use case này.
- [`specs/backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md`](../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md) — TASK-TG-04-06 (context preamble/env injection), phần "không cần đổi agent/" audit này xác nhận đúng-một-phần.
- [`docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md`](../../../../docs/crs/v3/flow-task/CR-FLOW-TASK-003-unified-task-activity-event-catalog.md) — Engine 1 (direct agent) coi là đồng bộ, không cần event — khớp với `agent.execPrompt`'s bản chất unary/blocking.

## Trích dẫn file:line

- `backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:16-70,132-172` — doc comment tự-đối chiếu + `Execute()` thật.
- `agent/src/relay/agent-rpc-dispatch-agent-exec.ts:72,176` — case `agent.exec` (không caller) vs case `agent.execPrompt` (caller thật).
- `agent/src/relay/agent-print-mode-exec.ts:33-56,76-94,104-116` — `handleAgentExecPrompt`, giới hạn model, `buildAgentEnv` call.
- `agent/src/relay/agent-spawner.ts:358-384` — `buildAgentEnv`, `ORCA_TASK_ID`/`ORCA_PROJECT_ID` construction.
