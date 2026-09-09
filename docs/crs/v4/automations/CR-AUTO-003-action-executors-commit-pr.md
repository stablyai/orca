# CR-AUTO-003 — Action executor: `commit_push` & `create_pr`

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-003 |
| **Tên** | Thêm executor `commit_push` và `create_pr` cho automation action chain |
| **Loại** | Feature |
| **Priority** | P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go" |
| **Tác động HLD** | Automation domain, Git/SCM integration |
| **Tác động Features** | F14 (Automations) |

---

## Bối cảnh & Vấn đề gốc

F14's spec YAML dùng `commit`/`create_pr` như 2 action riêng biệt sau
`run_agent`. Audit xác nhận: **không executor nào cho 2 action này tồn
tại** trong bất kỳ implementation nào (Electron/Node/backend-go) — dù
logic commit/push/tạo PR **đã có sẵn, đã test, ở nơi khác trong repo**:

- Commit: `desktop/src/main/providers/dev-server-git-provider.ts:359`
  (`.commit()`), `desktop/src/main/providers/ssh-git-provider.ts:163`
  (`.commit()`).
- Push: RPC `git.push`
  (`desktop/src/main/runtime/rpc/methods/git.ts:238`).
- Tạo PR: `backend-go/services/scm-integration-service`'s
  `createPullRequest` (gRPC), và renderer's
  `frontend/src/renderer/src/store/slices/pull-request-generation.ts`
  (đã có UI flow tạo PR thủ công, dùng lại được làm tham chiếu API
  shape).

Không mảnh nào trong số này được gọi từ automation dispatch path hiện
tại — automation hôm nay dừng lại ở "chạy 1 agent prompt", mọi commit/PR
sau đó (nếu có) là do agent tự chạy `git`/`gh` bên trong prompt, không
phải 1 action riêng biệt, có thể audit/retry độc lập.

## Giải pháp đề xuất

**Phụ thuộc cứng vào [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md)**
— 2 executor này là 2 nhánh trong `execute_automation_chain.go`'s loop.

### Executor `commit_push`

```go
// backend-go/services/automation-service/internal/usecase/action_commit_push.go
func (e *CommitPushExecutor) Execute(ctx context.Context, action AutomationAction, runCtx RunContext) (ActionResult, error) {
    // config_json: { "message": string, "push": bool (default true) }
    // Gọi tới cùng RPC/provider path đã có, KHÔNG viết lại logic git:
    //   - qua agent RPC "git.commit" + "git.push" nếu runCtx nhắm 1 dev server/agent thật
    //   - dùng đúng provider (dev-server-git-provider vs ssh-git-provider) theo
    //     connection_type của target, giống cách EphemeralVmRelay/other relay đã chọn provider
}
```

Message template hỗ trợ biến giống spec YAML (`"chore: automated TODO
review"`) — cho phép interpolation đơn giản (`{{automation.name}}`,
`{{run.number}}`) nếu cần, nhưng bắt đầu với string tĩnh là đủ cho v1.

### Executor `create_pr`

```go
// backend-go/services/automation-service/internal/usecase/action_create_pr.go
func (e *CreatePrExecutor) Execute(ctx context.Context, action AutomationAction, runCtx RunContext) (ActionResult, error) {
    // config_json: { "title": string, "body": string (optional), "base": string (optional, default repo default branch) }
    // Gọi gRPC thật tới scm-integration-service.createPullRequest — KHÔNG tự
    // gọi GitHub/GitLab API trực tiếp, tái dùng đúng service đã handle multi-provider
    // (xem AGENTS.md's "Git Provider Compatibility" — không hardcode GitHub-only)
}
```

`scm-integration-service` đã trừu tượng hoá GitHub/GitLab (theo AGENTS.md
yêu cầu), nên executor này tự động support cả 2 provider mà không cần
logic riêng.

### UI (renderer)

`AutomationEditorDialog.tsx` cần thêm bước chọn action type khi thêm 1
action vào chain (dropdown `create_worktree | run_agent | commit_push |
create_pr | send_notification | run_script`), và với `commit_push`/
`create_pr` cụ thể: form field cho `message`/`title`/`body`/`base`. Đây
là phần UI chung cho toàn bộ 4 action loại còn thiếu (chia sẻ component
`AutomationActionConfigForm` giữa CR-AUTO-003 và CR-AUTO-004, tránh 2 CR
viết 2 form pattern khác nhau).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng CR-AUTO-002 | Cao | Không có `actions[]` thì không có chỗ gắn executor |
| `create_pr` action chạy tự động, không có review trước khi tạo PR thật | Trung bình | Cân nhắc thêm option "draft PR" mặc định `true` cho automation-tạo PR, giảm rủi ro spam PR khi automation lỗi logic |
| Multi-provider (GitHub/GitLab) qua `scm-integration-service` chưa test hết edge case cho automation context (vd. token/credential nào dùng khi automation chạy không có user session) | Trung bình | Cần xác định automation chạy dùng credential nào — service account, hay token của user tạo automation (lưu tại thời điểm tạo) |
| `commit_push` chọn sai provider (dev-server vs ssh) nếu `runCtx`'s target ambiguous | Thấp | Tái dùng đúng logic chọn provider đã có ở relay khác, không tự suy luận mới |

## Không thuộc phạm vi CR này

- Executor `run_script`/`send_notification` — xem CR-AUTO-004.
- Executor `create_worktree` (đã có qua `workspaceMode: 'new_per_run'` +
  `headless-workspace-create.ts` — chỉ cần adapt thành 1 action type
  trong chain thay vì cờ cấu hình, việc nhỏ, gộp vào CR-AUTO-002 khi thêm
  loop thay vì CR riêng).
- Message/title template engine phức tạp (Jinja-like) — v1 dùng string
  tĩnh + vài biến cố định.

## Liên quan

- `desktop/src/main/providers/dev-server-git-provider.ts:359`,
  `desktop/src/main/providers/ssh-git-provider.ts:163` (`.commit()`)
- `desktop/src/main/runtime/rpc/methods/git.ts:238` (`git.push`)
- `backend-go/services/scm-integration-service` (`createPullRequest`)
- `frontend/src/renderer/src/store/slices/pull-request-generation.ts` (tham chiếu UI flow PR thủ công)
- `frontend/src/renderer/src/components/automations/AutomationEditorDialog.tsx`
- [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md) (phụ thuộc cứng)
