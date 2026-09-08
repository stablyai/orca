# SOL-AGENT-TASKV1-001: Fix `env`/`taskId`/`projectId` injection cho OrcaTask Run-Agent

**Giải quyết:** [BUG-AGENT-TASKV1-001](../BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md)

## Gap này nằm ở đâu?

**✅ Không nằm ở `agent/`.** RPC `agent.execPrompt` đã tồn tại, đúng shape,
hoạt động, và đã nhận đúng bởi `task-service.SimpleExecutor`
(`backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:169-172`).
Gap thật là 2 tầng đều ở **backend-go**:

1. `SimpleExecutor.Execute` xây `agentExecPromptParams` chỉ với
   `{Prompt, WorktreePath, StepID}` — **không có field `Env`** — nên dù
   `agent.execPrompt` sẵn sàng nhận `env` tuỳ ý (đã tự xác nhận đọc code thật
   `agent/src/relay/agent-print-mode-exec.ts:51-54`), backend-go không bao
   giờ gửi.
2. Ngay cả khi field `Env` được thêm, base injection của
   `handleAgentExecPrompt` (gọi `buildAgentEnv(...)` tại
   `agent/src/relay/agent-print-mode-exec.ts:109-116`) suy `ORCA_TASK_ID` từ
   `stepId` (request id) chứ không phải `task.ID` miền nghiệp vụ, và không
   bao giờ set `ORCA_PROJECT_ID` vì lời gọi không truyền `projectId` vào
   object literal.

Task chính đã ghi rõ: **"agent/: không cần thay đổi RPC contract"** — solution
này giữ nguyên kết luận đó. Việc cần làm nằm 100% ở
`backend-go/services/task-service`.

**Đối chiếu backend-go đã track chưa:** đã được track đúng ở
[`specs/backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md`](../../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md)
(mục "Context preamble + env-var injection... — no `agent/` change needed",
trỏ tới
[`TASK-TG-04-06`](../../../../backend-go/bugs/logic-v1/tasks/TASK-TG-04-06-context-preamble-env-injection.md))
và có solution đầy đủ ở
[`SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md`](../../../../backend-go/bugs/task-v1/solutions/SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md).
Ngoài ra, cùng root-cause ("`agent.exec`/`agent.execPrompt` env shape") còn
được thiết kế đầy đủ ở
[`SOL-PRF-04-profile-aware-agent-execution.md`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md)
(áp dụng cho cả `workflow-service` lẫn `task-service`, xem
[TASK-PRF-04-08](../../../../backend-go/bugs/logic-v1/tasks/TASK-PRF-04-08-task-service-simple-executor-env-injection.md)).
**Không có gap chưa-track nào ở đây** — solution này chỉ tóm tắt lại đúng thay
đổi cần làm từ góc nhìn "agent/ đã sẵn sàng, chỉ cần backend-go dùng đúng",
và bổ sung 1 đề xuất nhỏ, không bắt buộc, ở phía `agent/`.

## Giải pháp phía backend-go (đã có thiết kế — tóm tắt lại, không lặp SOL-TASKV1-004/SOL-PRF-04)

`SimpleExecutor.Execute` cần đổi `agentExecPromptParams` thành:

```go
type agentExecPromptParams struct {
    Prompt       string            `json:"prompt"`
    WorktreePath string            `json:"worktreePath"`
    StepID       string            `json:"stepId,omitempty"`
    Env          map[string]string `json:"env,omitempty"` // MỚI
}
```

và set:

```go
env := map[string]string{
    "ORCA_TASK_ID":    task.ID,        // task.ID miền nghiệp vụ, KHÔNG PHẢI requestID
    "ORCA_PROJECT_ID": task.ProjectID,
}
```

trước khi build `paramsJSON`. Đây chính xác là những gì `TASK-TG-04-06`/
`SOL-PRF-04` đã đặc tả — không lặp lại chi tiết implement ở đây, chỉ xác nhận
route đúng cho ai đọc từ phía `agent/`.

## Đề xuất nhỏ, không bắt buộc, ở phía `agent/`

Hiện `agent.execPrompt`'s `handleAgentExecPrompt`
(`agent/src/relay/agent-print-mode-exec.ts:33-46,109-116`) chỉ đọc
`params.stepId` và gán thẳng vào `taskId` khi gọi `buildAgentEnv(...)` —
không có field `taskId`/`projectId` tường minh nào riêng biệt, khác với
`agent.spawn`'s `AgentSpawnRequest` vốn đã có `taskId: string` và
`projectId?: string` là 2 field độc lập
(`agent/src/relay/agent-spawner.ts:345-346`, dùng bởi `buildAgentEnv`'s
normalise-block dòng 371-372,381,383).

**Đề xuất (tùy chọn, không bắt buộc để fix bug này — backend-go có thể fix
hoàn toàn qua đường `env` mà không cần đợi thay đổi này):**

```typescript
// agent-print-mode-exec.ts — thêm 2 field tường minh, tách khỏi stepId
const taskId    = typeof params.taskId === 'string' ? params.taskId : ''
const projectId = typeof params.projectId === 'string' ? params.projectId : ''
// ...
env = await buildAgentEnv(
  { accountId, userId: '', taskId: taskId || (stepId ?? ''), projectId, cwd: worktreePath, model: modelId, extraEnv },
  spec, config, null, log, span.id
)
```

Lý do đề xuất: giảm rủi ro nhầm lẫn "task ID" ↔ "request ID" cho bất kỳ
backend nào (kể cả `workflow-service`, nếu sau này cũng cần env tương tự —
xem [BUG-AGENT-TASKV1-004](./SOL-AGENT-TASKV1-004-workflow-service-agent-step-executor-still-broken.md))
gọi RPC này trong tương lai — nhưng **không phải fix bắt buộc**: nếu
backend-go gửi `ORCA_TASK_ID`/`ORCA_PROJECT_ID` qua `params.env` (nhánh
`extraEnv`, đã hoạt động đúng hôm nay), giá trị đó **ghi đè** giá trị suy ra
từ `stepId`/`buildAgentEnv`'s base env (merge order đã xác nhận đúng ở
`agent-print-mode-exec.ts:47-50`'s comment "merged on top of
buildAgentEnv()'s base env via its own extraEnv slot") — nên backend-go có
thể tự đóng gap hoàn toàn mà không cần đợi thay đổi này.

## Giới hạn model — không phải bug, là scope hiện tại

`agent.execPrompt` chỉ hỗ trợ `model === 'claude'`
(`agent-print-mode-exec.ts:82-94`, mã lỗi
`UNSUPPORTED_MODEL_FOR_ONE_SHOT_EXEC`). Đây là giới hạn khả năng thật —
codex/gemini/opencode's print-mode flag chưa được verify. **Không đề xuất
thay đổi trong solution này** — nếu product cần đa-model cho OrcaTask
Run-Agent, cần 1 CR riêng để verify + thêm flag cho từng binary (ngoài phạm
vi bug này).

## Test plan (nếu backend-go áp dụng thay đổi Env)

Đã được `SOL-TASKV1-004`/`SOL-PRF-04`'s test plan bao phủ
(`agent_step_executor_test.go`/`simple_executor_test.go` kiểu regression:
assert `env["ORCA_TASK_ID"] == task.ID` gửi trong `paramsJSON`, không phải
`requestID`). Không cần test mới ở `agent/` vì `params.env` passthrough đã
có test coverage hiện tại của `agent-print-mode-exec.test.ts`.

## Kết luận / Status

**✅ Không cần action bắt buộc ở `agent/`.** Solution này chỉ để hoàn thiện
audit: xác nhận route fix đúng nằm ở `task-service.SimpleExecutor` (đã có
thiết kế ở `SOL-TASKV1-004`/`SOL-PRF-04`, chưa merge tại thời điểm audit),
và ghi 1 đề xuất optional cho `agent/` nếu muốn giảm rủi ro nhầm lẫn field
trong tương lai.

## Tham khảo

- [`specs/backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md`](../../../../backend-go/bugs/task-v1/BUG-TASKV1-004-orcatask-run-agent-execution-gaps.md)
- [`specs/backend-go/bugs/task-v1/solutions/SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md`](../../../../backend-go/bugs/task-v1/solutions/SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md)
- [`specs/backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md)

## Trích dẫn file:line (đọc trực tiếp, 2026-09-08)

- `agent/src/relay/agent-print-mode-exec.ts:33-46,51-54,75-94,109-116` — `handleAgentExecPrompt`, `extraEnv` passthrough, giới hạn model, `buildAgentEnv` call thiếu `taskId`/`projectId` tường minh.
- `agent/src/relay/agent-spawner.ts:345-346,371-372,381,383` — `AgentEnvRequest`'s `taskId`/`projectId` fields riêng biệt (mẫu tham khảo cho đề xuất optional).
- `backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go:169-172` — caller thật, xác nhận thiếu field `Env`.
