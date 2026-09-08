# TASK-AGENT-TASKV1-03: (Optional) Tách `taskId`/`projectId` tường minh khỏi `stepId` trong `handleAgentExecPrompt`

**Task ID:** TASK-AGENT-TASKV1-03
**Priority:** 🟢 P3 (optional, không bắt buộc — không có backend-go caller nào
bị chặn nếu bỏ qua task này)
**Bugs fixed:** [BUG-AGENT-TASKV1-001](../BUG-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md)
(mục "Đề xuất nhỏ, không bắt buộc")
**Solution:** [SOL-AGENT-TASKV1-001](../solutions/SOL-AGENT-TASKV1-001-orcatask-run-agent-execprompt-verification.md)
§"Đề xuất nhỏ, không bắt buộc, ở phía `agent/`"
**Estimated effort:** Rất nhỏ
**Dependencies:** Không
**Status:** [ ] TODO

---

## Vì sao task này KHÔNG bắt buộc

Gap thật của BUG-AGENT-TASKV1-001 (thiếu `env`/`ORCA_TASK_ID`/`ORCA_PROJECT_ID`
injection cho OrcaTask Run-Agent) nằm 100% ở
`backend-go/services/task-service/internal/adapter/grpcclient/simple_executor.go`
— đã có thiết kế đầy đủ ở
[`SOL-TASKV1-004`](../../../../backend-go/bugs/task-v1/solutions/SOL-TASKV1-004-orcatask-run-agent-execution-gaps.md)/
[`SOL-PRF-04`](../../../../backend-go/bugs/logic-v1/solutions/SOL-PRF-04-profile-aware-agent-execution.md).
Backend-go có thể đóng gap đó hoàn toàn bằng cách gửi `ORCA_TASK_ID`/
`ORCA_PROJECT_ID` qua `params.env` (nhánh `extraEnv` — đã hoạt động đúng
hôm nay, merge đè lên base env theo đúng thứ tự
`agent-print-mode-exec.ts:47-50`), **không cần đợi task này**.

Task này chỉ là 1 cải thiện nhỏ, giảm rủi ro nhầm lẫn "task ID nghiệp vụ" ↔
"request ID giao thức" cho bất kỳ backend nào gọi `agent.execPrompt` trong
tương lai (không riêng `task-service`) — làm khi rảnh, không cần ưu tiên.

---

## Bối cảnh

`handleAgentExecPrompt` (`agent/src/relay/agent-print-mode-exec.ts:41,109-116`)
hiện chỉ đọc `params.stepId` và gán thẳng giá trị đó làm `taskId` khi gọi
`buildAgentEnv(...)`:

```typescript
// dòng 41
const stepId = typeof params.stepId === 'string' ? params.stepId : undefined
// ...
// dòng 109-116
env = await buildAgentEnv(
  { accountId, userId: '', taskId: stepId ?? '', cwd: worktreePath, model: modelId, extraEnv },
  spec, config, null, log, span.id
)
```

Khác với `agent.spawn`'s `AgentSpawnRequest`, vốn đã có 2 field độc lập
`taskId: string` và `projectId?: string`
(`agent/src/relay/agent-spawner.ts:345-346`, dùng bởi `buildAgentEnv`'s
normalise-block dòng 371-372,381,383) — `agent.execPrompt` không có field
`taskId`/`projectId` tường minh nào, chỉ có `stepId` (request-scoped).

**File cần sửa:** `agent/src/relay/agent-print-mode-exec.ts`.

---

## Implementation

Thêm 2 field đọc tường minh từ `params`, ưu tiên chúng khi build env,
nhưng vẫn fallback về `stepId` nếu backend chưa gửi (giữ backward-compat
100% với `task-service`/`workflow-service` hôm nay, vốn chỉ gửi `stepId`):

```typescript
// sau dòng 41 (khai báo stepId)
const taskId = typeof params.taskId === 'string' ? params.taskId : ''
const projectId = typeof params.projectId === 'string' ? params.projectId : ''
```

```typescript
// thay đoạn buildAgentEnv (dòng 109-116)
env = await buildAgentEnv(
  {
    accountId,
    userId: '',
    taskId: taskId || (stepId ?? ''),
    projectId,
    cwd: worktreePath,
    model: modelId,
    extraEnv
  },
  spec,
  config,
  null,
  log,
  span.id
)
```

Không đổi response shape, không đổi hành vi khi `params.taskId`/
`params.projectId` không được gửi (fallback giữ nguyên hành vi cũ).

---

## Unit Tests to Add

File: `agent/src/relay/agent-print-mode-exec.test.ts`

```typescript
it('prefers explicit params.taskId/projectId over stepId when building env', async () => {
  const promise = handleAgentExecPrompt(
    1,
    { prompt: 'hi', worktreePath: '/repo', stepId: 'req-1', taskId: 'task-42', projectId: 'proj-7' },
    config, log
  )
  const child = getLastSpawnedChild()
  child.emit('close', 0)
  await promise
  // assert buildAgentEnv/spawn's env has ORCA_TASK_ID=task-42, ORCA_PROJECT_ID=proj-7
  // (theo đúng cách test hiện có 'merges caller-provided env...' dòng 171-188 assert env)
})

it('falls back to stepId as taskId when params.taskId is absent (backward-compat)', async () => {
  // giữ nguyên hành vi cũ khi backend chưa gửi taskId/projectId
})
```

---

## Verification

```bash
cd agent
npx tsc --noEmit -p config/tsconfig.node.json 2>&1 | grep agent-print-mode-exec
npx vitest run src/relay/agent-print-mode-exec.test.ts
```
