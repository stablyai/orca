# BE-AUTO-SOL-003: Executor `commit_push`/`create_pr`

> **🔲 Designed — chưa implement.** Phụ thuộc cứng BE-AUTO-SOL-002.

**CR:** [CR-AUTO-003](../../../../../../docs/crs/v4/automations/CR-AUTO-003-action-executors-commit-pr.md)
**Agent counterpart:** không có — `git.commit`/`git.push` đã tồn tại thật ở agent, xem [SOL-AG-AUTO-001 README](../../../../agent/crs/v4/automation/solutions/README.md)
**Service:** `automation-service`, `workflow-service` (mở rộng), `scm-integration-service` (gọi qua)
**TDD tham chiếu:** [`workflow-service.md`](../../../../tdd/services/workflow-service.md) §step executors, [`scm-integration-service.md`](../../../../tdd/services/scm-integration-service.md)

---

## 1. Trạng thái hiện tại — quan trọng, thay đổi thiết kế so với CR gốc

Audit khi viết solution (khác thời điểm viết CR) xác nhận: **agent đã có
`git.commit`/`git.push` RPC thật** (`agent-rpc-dispatch-git-status.ts:40,50`,
`git-handler.ts:295,317`, có test). Nhưng **`workflow-service` không có
step executor nào gọi 2 RPC này** — `StepType` enum chỉ có
`AGENT`/`SHELL`/`NOTIFICATION`/`WEBHOOK`/`CONDITION`
(`internal/domain/step.go:18-19`), không có `GIT_COMMIT`/`COMMIT_PUSH`.
CR-AUTO-003's gốc đề xuất gọi trực tiếp qua "dev-server-git-provider.ts"
(nhầm layer — đó là code Electron main, không phải backend-go/agent) —
**sửa lại**: thiết kế đúng là thêm 1 step executor Go mới, theo đúng
khuôn `shell_step_executor.go` đã có, gọi RPC `git.commit`/`git.push`
đã tồn tại ở agent.

## 2. Giải pháp: `commit_push`

### Thêm `StepTypeCommitPush` vào `workflow-service`

```go
// internal/domain/step.go
const StepTypeCommitPush StepType = "commit_push"
```

### `GitCommitPushExecutor` — theo đúng khuôn `ShellExecutor`

```go
// internal/adapter/infrafleetclient/git_commit_push_executor.go
type gitCommitPushParams struct {
    Message string `json:"message"`
    Push    bool   `json:"push"` // default true nếu thiếu — xử lý ở Unmarshal hoặc default riêng
}

func (e *GitCommitPushExecutor) Execute(ctx context.Context, stepConfigJSON string) (domain.StepResult, error) {
    var cfg gitCommitPushParams
    json.Unmarshal([]byte(stepConfigJSON), &cfg)
    if _, err := relay(ctx, e.client, cfg.ConnectionID, "git.commit", map[string]any{"message": cfg.Message}, &commitResult); err != nil {
        return domain.StepResult{}, err
    }
    if cfg.Push {
        if _, err := relay(ctx, e.client, cfg.ConnectionID, "git.push", map[string]any{}, &pushResult); err != nil {
            return domain.StepResult{}, err
        }
    }
    return toStepResult(...), nil
}
```

Đọc kỹ `git.commit`/`git.push`'s params/response shape thật ở
`agent-rpc-dispatch-git-status.ts:40-60` trước khi khoá `gitCommitPushParams`
— không đoán shape, agent đã có contract thật, executor phải khớp nó
(không phải ngược lại).

### `execute_automation_chain.go`'s dispatch (BE-AUTO-SOL-002)

```go
case AUTOMATION_ACTION_TYPE_COMMIT_PUSH:
    return e.workflowClient.ExecuteAdHocStep(ctx, workflowv1.StepType_STEP_TYPE_COMMIT_PUSH, action.ConfigJson)
```

## 3. Giải pháp: `create_pr`

Không qua `workflow-service`/agent — gọi thẳng
`scm-integration-service`'s `createPullRequest` gRPC (đã thật, đa
provider GitHub/GitLab theo AGENTS.md). Thêm 1 nhánh riêng trong
`execute_automation_chain.go`'s `dispatch()` (không map qua `StepType`,
vì đây không phải 1 workflow step — gọi service khác trực tiếp):

```go
case AUTOMATION_ACTION_TYPE_CREATE_PR:
    return e.scmClient.CreatePullRequest(ctx, &scmv1.CreatePullRequestRequest{
        Title: cfg.Title, Body: cfg.Body, Base: cfg.Base, /* repo/branch từ automation context */
    })
```

Xác nhận `automation-service` đã có gRPC client tới
`scm-integration-service` chưa (kiểm tra
`internal/adapter/grpcclient/` trước khi thêm client mới) — nếu chưa,
thêm theo đúng khuôn `workflow_client.go` đã có cho `workflow-service`.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng BE-AUTO-SOL-002 | Cao | Cần `actions[]`/dispatch loop tồn tại |
| `git.commit`/`git.push`'s params/response shape thật chưa được đọc kỹ trong solution này | Trung bình | Bắt buộc đọc `agent-rpc-dispatch-git-status.ts` đầy đủ trước khi code, không suy đoán từ tên method |
| `create_pr` tự động, không review trước khi tạo PR thật | Trung bình | Cân nhắc `draft: true` mặc định — xem CR-AUTO-003's rủi ro gốc |
| `automation-service` có gRPC client tới `scm-integration-service` chưa | Chưa xác nhận | Cần kiểm tra trước khi ước lượng effort chính xác |

## Không thuộc phạm vi solution này

- `run_script`/`send_notification` — xem
  [BE-AUTO-SOL-004](./BE-AUTO-SOL-004-action-executors-script-notification.md)
  (nhẹ hơn nhiều — không cần step type mới).
- `create_worktree` — gộp vào BE-AUTO-SOL-002's `dispatch()` (dùng
  `OrcaRuntimeService.createManagedWorktree` qua đường đã có ở frontend/
  desktop, không phải backend-go — nếu canonical backend-go cần tạo
  worktree, cần xác nhận backend-go có đường gọi worktree creation nào
  chưa, đây là 1 câu hỏi mở cần trả lời khi implement BE-AUTO-SOL-002,
  không lặp lại ở đây).

## Liên quan

- `agent/src/relay/agent-rpc-dispatch-git-status.ts:40,50`
- `backend-go/services/workflow-service/internal/domain/step.go:18-19`
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/shell_step_executor.go` (khuôn mẫu)
- `backend-go/services/scm-integration-service` (`createPullRequest`)
- [BE-AUTO-SOL-002](./BE-AUTO-SOL-002-multi-action-chain-data-model.md) (phụ thuộc cứng)
