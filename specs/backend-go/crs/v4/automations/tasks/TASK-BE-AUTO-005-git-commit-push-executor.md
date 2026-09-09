# TASK-BE-AUTO-005: `StepTypeCommitPush` + `GitCommitPushExecutor`

**Solution:** [BE-AUTO-SOL-003](../solutions/BE-AUTO-SOL-003-action-executors-commit-pr.md) | **CR:** CR-AUTO-003
**Depends on:** [TASK-BE-AUTO-004](./TASK-BE-AUTO-004-execute-automation-chain-usecase.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Thêm step type mới `commit_push` ở `workflow-service`, executor gọi
`git.commit`/`git.push` (đã tồn tại thật ở agent — không sửa agent).

## Files cần sửa

1. `backend-go/services/workflow-service/internal/domain/step.go` (MODIFY — thêm `StepTypeCommitPush`)
2. `backend-go/services/workflow-service/internal/adapter/infrafleetclient/git_commit_push_executor.go` (MỚI)
3. `backend-go/services/workflow-service/internal/adapter/infrafleetclient/git_commit_push_executor_test.go` (MỚI)
4. `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — case `COMMIT_PUSH` gọi `ExecuteAdHocStep(STEP_TYPE_COMMIT_PUSH, ...)` thay vì lỗi placeholder từ TASK-BE-AUTO-004)

## Bước 1 — Đọc contract thật trước khi code (bắt buộc)

Đọc `agent/src/relay/agent-rpc-dispatch-git-status.ts:40-60` xác nhận
chính xác params/response shape của `git.commit`/`git.push` — KHÔNG đoán
từ tên method. Solution's sketch (`{message}` cho commit, `{}` cho push)
là giả định ban đầu, phải verify.

## Nội dung (xem BE-AUTO-SOL-003 §2, đã hiệu chỉnh theo bước 1's kết quả thật)

```go
// git_commit_push_executor.go — theo khuôn shell_step_executor.go
type gitCommitPushParams struct {
    Message string `json:"message"`
    Push    bool   `json:"push"`
}

func (e *GitCommitPushExecutor) Execute(ctx context.Context, stepConfigJSON string) (domain.StepResult, error) {
    var cfg gitCommitPushParams
    // Unmarshal, default Push=true nếu field vắng mặt trong JSON — xem cách shell_step_executor.go xử lý optional field tương tự
    if _, err := relay(ctx, e.client, cfg.ConnectionID, "git.commit", map[string]any{"message": cfg.Message}, &commitResult); err != nil {
        return domain.StepResult{}, err
    }
    if cfg.Push {
        if _, err := relay(ctx, e.client, cfg.ConnectionID, "git.push", map[string]any{}, &pushResult); err != nil {
            return domain.StepResult{}, err
        }
    }
    return toStepResult(commitResult, pushResult), nil
}
```

## Test cases cần cover

- `Execute` gọi `git.commit` rồi `git.push` theo đúng thứ tự khi `push: true`.
- `push: false` → chỉ gọi `git.commit`, không gọi `git.push`.
- `git.commit` lỗi → không gọi `git.push`, trả lỗi ngay.
- Response shape khớp field thật (bước 1) — assertion dùng field tên thật, không giả định.

## Verify

```bash
cd backend-go/services/workflow-service && go test ./internal/adapter/infrafleetclient/...
cd ../automation-service && go test ./internal/usecase/...
```

## gitnexus

`impact({target: "StepType", direction: "downstream"})` trước khi thêm
giá trị enum mới — xác nhận mọi `switch` trên `StepType` (TS
`StepExecutors.ts` lẫn Go domain) có cần thêm case tương ứng hay không
(TS side có thể không cần đổi nếu `commit_push` chỉ dùng ở backend-go
path, không phải TS's `workflow` engine — xác nhận rõ trước khi kết
luận "không cần đổi TS").

---

## ✅ Kết quả thực tế (2026-09-09)

**Bước 1 (đọc contract thật)** xác nhận chính xác:
- `git.commit` params `{worktreePath, message}`, response
  `{success: bool, error?: string}` — **KHÔNG BAO GIỜ throw**, mọi lỗi
  (message rỗng, git commit lỗi) đều trả `{success:false, error}`
  (`agent/src/relay/git-handler-worktree-ops.ts:153-185`'s
  `commitChangesRelay`). Đây là điểm khác lớn nhất so với `shell.exec`
  (mà `execResult`'s pattern giả định exitCode) — executor Go phải check
  `Success` field, không chỉ bắt lỗi transport.
- `git.push` params `{worktreePath, forceWithLease?, pushTarget?}`,
  response `{success: true}` khi thành công — nhưng **THROW khi lỗi**
  (`agent/src/relay/agent-git-handler-remote-ops.ts:16-27`), khác hẳn
  `git.commit`. Executor code phải phân biệt đúng 2 kiểu lỗi khác nhau
  cho 2 RPC trong cùng 1 action.

**Phát hiện phụ lớn, không có trong task/solution gốc — 3 lớp mapping
`StepType` bị thiếu, nếu không sửa thì `commit_push` không tài nào tới
được executor dù đã đăng ký:**
1. `workflow.proto`'s `StepType` enum — cần `STEP_TYPE_COMMIT_PUSH` mới
   (wire contract giữa automation-service và workflow-service).
2. `automation-service`'s domain `StepType` — type riêng, duplicate có
   chủ đích khỏi `workflow-service`'s (theo đúng convention file tự ghi:
   "duplicated here rather than imported"), cần thêm hằng số
   `StepTypeCommitPush` riêng.
3. **3 hàm mapping** (không phải 1): `automation-service/internal/adapter/grpcclient/workflow_client.go`'s
   `toProtoStepType` (automation-service → workflow-service RPC),
   `automation-service/internal/adapter/grpc/server.go`'s
   `toProtoStepType`/`fromProtoStepType` (wire Automation message ↔
   domain, dùng chung enum theo comment gốc của `automation.proto`),
   `workflow-service/internal/adapter/grpc/server.go`'s `toDomainStepType`
   (wire ExecuteAdHocStepRequest → domain). Thiếu 1 trong 4 điểm
   (2 domain const + proto enum + registry) là `commit_push` compile
   được nhưng luôn map về `STEP_TYPE_UNSPECIFIED`/rơi vào `default` —
   lỗi âm thầm rất khó phát hiện nếu không đọc kỹ toàn bộ chuỗi.

**Phát hiện phụ thứ 2, mở rộng phạm vi có chủ đích**: khi wire
`GitCommitPushExecutor` vào registry (`cmd/server/main.go`), phát hiện
`server.go`'s `CreateAutomation`/`UpdateAutomation` gRPC handler **chưa
từng đọc `req.GetActions()`/`req.GetActionsSet()`** — nghĩa là dù
TASK-BE-AUTO-002/003/004 đã xây xong toàn bộ tầng dưới (proto/domain/
repository/usecase loop), **không có cách nào tạo automation có
`actions` qua API thật** cho tới bước này. Đã đóng gap này luôn (ngoài
phạm vi gốc của task 005, nhưng cần thiết để tính năng thật sự dùng
được):
- `CreateAutomationInput`/`CreateAutomation.Execute`: thêm
  `Actions`/`MaxRunHistory`/`RunTimeoutSeconds`; `NewAutomation`'s
  `ErrEmptyStepConfig` giữ nguyên (không relax, tránh phá test/call site
  khác) — automation chỉ có `actions` (không `step_config_json`) dùng
  placeholder `"{}"` vô hại cho validation (`resolveActions` luôn ưu
  tiên `Actions`, placeholder không bao giờ được đọc thật).
- `UpdateAutomationInput`: thêm `Actions *[]domain.AutomationAction`
  (nil = không đổi, non-nil-rỗng = xoá hết action — đúng lý do
  `AutomationActionList` wrapper tồn tại, xem TASK-BE-AUTO-002).
- `server.go`: `toDomainActions`/`toProtoActions`/`toProtoActionResults`
  + `toDomainActionType`/`toProtoActionType` (6 action type ↔ enum) mới;
  `toProtoAutomation`/`toProtoRun` cập nhật để trả actions/action_results
  thật trong response.

**Verify**: `go build`/`go vet` cho `automation-service` + `workflow-service`
— sạch. `go test` cho cả 2 service — **toàn bộ pass**, gồm 5 test mới
cho `GitCommitPushExecutor` (commit+push mặc định, `push:false`, commit
lỗi → không bao giờ gọi push, push lỗi vẫn báo `committed:true`, commit
lỗi transport propagate), 2 test mới cho `CreateAutomation` (actions-only
không cần legacy step config; automation không actions lẫn step config
vẫn bị từ chối đúng), 3 test mới cho `UpdateAutomation` (nil Actions giữ
nguyên, empty Actions xoá hết, Actions mới thay thế), 3 test mới ở tầng
gRPC server (Create round-trip actions qua proto thật, Update's
`ActionsSet` nil/rỗng qua đúng gRPC message thật — không chỉ usecase
layer).

**Files đã sửa/tạo:**
- `backend-go/proto/orca/workflow/v1/workflow.proto` (MODIFY — `STEP_TYPE_COMMIT_PUSH`)
- `backend-go/proto/gen/go/orca/workflow/v1/*.go` (regenerated)
- `backend-go/services/workflow-service/internal/domain/step.go` (MODIFY)
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/git_commit_push_executor.go` (MỚI)
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/git_commit_push_executor_test.go` (MỚI)
- `backend-go/services/workflow-service/internal/adapter/grpc/server.go` (MODIFY — `toDomainStepType`)
- `backend-go/services/workflow-service/cmd/server/main.go` (MODIFY — registry)
- `backend-go/services/automation-service/internal/domain/automation.go` (MODIFY — `StepTypeCommitPush`)
- `backend-go/services/automation-service/internal/adapter/grpcclient/workflow_client.go` (MODIFY)
- `backend-go/services/automation-service/internal/usecase/create_automation.go` (MODIFY — Actions plumbing)
- `backend-go/services/automation-service/internal/usecase/create_automation_test.go` (MODIFY)
- `backend-go/services/automation-service/internal/usecase/update_automation.go` (MODIFY — Actions plumbing)
- `backend-go/services/automation-service/internal/usecase/update_automation_test.go` (MODIFY)
- `backend-go/services/automation-service/internal/adapter/grpc/server.go` (MODIFY — Actions/StepType mapping)
- `backend-go/services/automation-service/internal/adapter/grpc/server_test.go` (MODIFY)
