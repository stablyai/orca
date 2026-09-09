# agent Solutions — Automations (v4)

**CRs:** [docs/crs/v4/automations/](../../../../../../docs/crs/v4/automations/README.md)
**backend-go counterpart:** [specs/backend-go/crs/v4/automations/solutions/](../../../../backend-go/crs/v4/automations/solutions/README.md)
**Frontend counterpart:** [specs/frontend/crs/v4/automation/solutions/](../../../../frontend/crs/v4/automation/solutions/README.md)
**TDD tham chiếu:** [TDD-AG-07](../../../../tdd/v5/07-jsonrpc-dispatch.md) §1 (JSON-RPC Method Router)

## Đánh giá trạng thái hiện tại — trước khi thiết kế bất kỳ giải pháp nào

Trái với `docs/crs/v3/ephemeral-vm/`'s 5 CR đầu (nơi agent phải xây mới
gần như từ đầu), audit trực tiếp mã nguồn agent cho 8 CR-AUTO cho thấy
**agent (Dev Server Agent, `agent/`) hầu như không cần thay đổi gì**:
mọi RPC method mà 8 CR-AUTO cần đều **đã tồn tại thật, đã test**, ở agent
từ trước khi nhóm CR này được viết:

| RPC method agent đã có | Dùng cho CR nào | File | Trạng thái |
|---|---|---|---|
| `git.commit` | CR-AUTO-003 (`commit_push` action) | `agent/src/relay/agent-rpc-dispatch-git-status.ts:40`, `git-handler.ts:295` | ✅ Thật, có test (`git-handler.test.ts:106`, `git-handler-staging.test.ts:72,92`) |
| `git.push` | CR-AUTO-003 (`commit_push` action) | `agent/src/relay/agent-rpc-dispatch-git-status.ts:50`, `git-handler.ts:317` | ✅ Thật, có test (`git-handler.test.ts:125`) |
| `shell.exec` | CR-AUTO-004 (`run_script` action) | `agent/src/relay/agent-rpc-dispatch-misc.ts:188` | ✅ Thật, có test (`agent-rpc-dispatch.test.ts:416-439`) |
| `notification.send` | CR-AUTO-004 (`send_notification` action) | `agent/src/relay/agent-rpc-dispatch-misc.ts:203`, `notification-send-handler.ts` | ✅ Thật, có test (`agent-rpc-dispatch.test.ts:441-459`) |

`create_pr` (CR-AUTO-003) không đi qua agent — `scm-integration-service`
(backend-go) gọi thẳng GitHub/GitLab API, không qua Dev Server Agent
relay. `create_worktree` (gộp vào CR-AUTO-002's loop) dùng
`OrcaRuntimeService.createManagedWorktree`, cũng không qua agent RPC.

**Kết luận: chỉ 1 solution cần cho toàn bộ nhóm CR-AUTO-001..008** — đóng
lại caveat "best-effort, not verified against a live Dev Server Agent"
mà chính 2 file executor Go (`shell_step_executor.go:14-16`,
`notification_step_executor.go:12-14`) tự ghi nhận. Đây đúng tinh thần
"ít thay đổi code nhất": không viết thêm handler nào, chỉ verify contract
đã có.

## Solutions

| Solution | CR | Status |
|---|---|---|
| [SOL-AG-AUTO-001](./SOL-AG-AUTO-001-verify-shell-notification-contract.md) | CR-AUTO-004 | 🔲 Designed — chưa implement |

## Không thuộc phạm vi nhóm solution này (đã có sẵn, không cần solution)

- CR-AUTO-001, 002, 005, 006, 007, 008 — không đụng agent RPC surface
  nào (CR-AUTO-005's "agent run hoàn thành" event, nếu cần, dùng tín
  hiệu đã có ở **Electron main process** — `AgentDetector`
  (`desktop/src/main/stats/agent-detector.ts`) — khác hoàn toàn với
  Dev Server Agent (`agent/`); xem
  [FE-AUTO-SOL-005](../../../../frontend/crs/v4/automation/solutions/FE-AUTO-SOL-005-real-event-triggers.md),
  không phải solution ở đây).
- CR-AUTO-003's `commit_push`/`create_pr` — `git.commit`/`git.push` đã
  đủ dùng ở agent; phần việc còn lại (executor gọi 2 RPC này từ
  `backend-go`) là backend-go, xem
  [BE-AUTO-SOL-003](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-003-action-executors-commit-pr.md).
