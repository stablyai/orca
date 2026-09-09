# CR-AUTO-004 — Action executor: `run_script` & `send_notification`

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-AUTO-004 |
| **Tên** | Map action `run_script`/`send_notification` vào `workflow-service`'s `STEP_TYPE_SHELL`/`STEP_TYPE_NOTIFICATION` đã chạy thật, không xây executor mới |
| **Loại** | Feature (chủ yếu wiring, không phải xây mới) |
| **Priority** | P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn theo yêu cầu "rà soát F14 ở frontend và backend-go" |
| **Tác động HLD** | Automation domain, Workflow domain |
| **Tác động Features** | F14 (Automations) |

---

## Bối cảnh & Vấn đề gốc

Audit ban đầu (báo cáo F14) kết luận "không executor nào cho
`run_script`/`send_notification`" — đúng ở tầng **automation**, nhưng
audit sâu hơn khi viết CR này phát hiện: **`workflow-service` (backend-go)
đã có sẵn 2 step type này, chạy thật đến tận agent**, và automation's
`step_type` (`automation.proto:32-48`) vốn **tái dùng chính enum
`orca.workflow.v1.StepType`** — nghĩa là hạ tầng cần thiết đã tồn tại
gần như trọn vẹn:

```
backend-go/proto/orca/workflow/v1/workflow.proto:53-58
  enum StepType {
    STEP_TYPE_AGENT = 1;
    STEP_TYPE_SHELL = 2;         ← dùng cho run_script
    STEP_TYPE_NOTIFICATION = 3;  ← dùng cho send_notification
    STEP_TYPE_WEBHOOK = 4;
  }
```

Chuỗi thực thi thật, đã có test, đã nối tới agent:

- **Shell**: `backend-go/services/workflow-service/internal/adapter/infrafleetclient/shell_step_executor.go`
  gọi relay method `shell.exec` (tới `infra-fleet-service`) → agent có
  handler thật tại `agent/src/relay/agent-rpc-dispatch-misc.ts:188`
  (`case 'shell.exec':`), có test
  (`agent-rpc-dispatch.test.ts:416-439`).
- **Notification**: `notification_step_executor.go` gọi relay method
  `notification.send` → agent có handler thật tại
  `agent/src/relay/notification-send-handler.ts` và dispatch case ở
  `agent-rpc-dispatch-misc.ts:203`, có test
  (`agent-rpc-dispatch.test.ts:441-459`).

Cả 2 executor Go đều tự ghi chú "Best-effort, not verified against a live
Dev Server Agent" (`shell_step_executor.go:14-16`,
`notification_step_executor.go:12-14`) — nghĩa là contract khớp bằng
code-reading 2 phía (TS agent handler ↔ Go executor's params shape), chưa
từng verify bằng 1 lần chạy thật end-to-end. Đây là việc cần làm ở CR
này, không phải xây executor từ đầu.

**Kết luận: gap thật ở đây là (1) automation action chain (CR-AUTO-002)
chưa tồn tại để có chỗ set `type: RUN_SCRIPT`/`SEND_NOTIFICATION` cho 1
action, và (2) chưa ai verify end-to-end path này chạy thật — không phải
"chưa có executor" như audit ban đầu nói.**

## Giải pháp đề xuất

**Phụ thuộc cứng vào [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md)**.

### Mapping action type → `StepType` có sẵn

Trong `execute_automation_chain.go`'s loop (CR-AUTO-002), map:

```go
case AUTOMATION_ACTION_TYPE_RUN_SCRIPT:
    return e.workflowClient.ExecuteAdHocStep(ctx, workflowv1.StepType_STEP_TYPE_SHELL, action.ConfigJson)
case AUTOMATION_ACTION_TYPE_SEND_NOTIFICATION:
    return e.workflowClient.ExecuteAdHocStep(ctx, workflowv1.StepType_STEP_TYPE_NOTIFICATION, action.ConfigJson)
```

`action.ConfigJson`'s shape với 2 action này **giữ nguyên** shape
`shellStepExecutor`/`notificationStepExecutor` đã định nghĩa
(`{script, env}` / `{channel, message}`) — không đổi contract.

### Verify end-to-end (đóng caveat "not verified")

Thêm 1 test tích hợp thật (không phải fake client) chạy `shell.exec` và
`notification.send` qua toàn bộ chain: `ExecuteAdHocStep` →
`infra-fleet-service` relay → agent thật (hoặc agent test harness đã có
sẵn cho `ephemeralVm`'s CR-EVM-001, tái dùng pattern đó) — đóng dứt điểm
caveat "not verified against a live Dev Server Agent" đang tồn tại ở cả
2 file executor.

### UI (renderer)

Thêm 2 action config form vào `AutomationActionConfigForm` (component
chung, xem [CR-AUTO-003](./CR-AUTO-003-action-executors-commit-pr.md)):
- `run_script`: textarea cho `script`, key-value editor cho `env`.
- `send_notification`: input `channel` (dropdown nếu có danh sách channel
  cố định — kiểm tra F11's channel model trước khi thiết kế field này,
  không tự đặt tên channel mới không khớp F11), textarea `message`.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng CR-AUTO-002 | Cao | Không có `actions[]` thì không có chỗ set action type này |
| Contract `shell.exec`/`notification.send` chưa từng verify thật (chỉ code-reading 2 phía) | Trung bình | CR này nên bao gồm 1 lần verify thật trước khi ship — nếu params shape lệch, cần sửa ở agent hoặc executor, phát hiện sớm rẻ hơn phát hiện sau khi user dùng automation thật |
| `run_script` chạy shell command tuỳ ý qua automation | Trung bình-Cao | Cùng class rủi ro đã nêu ở README's "Rủi ro chung" — kế thừa credentials của máy đích; không mở rộng thêm rủi ro so với `shell.exec` đã tồn tại cho workflow step khác, nhưng automation (chạy tự động theo cron, không cần user bấm) làm bề mặt tấn công/lỗi rộng hơn 1 workflow chạy thủ công — cân nhắc thêm confirm/audit-log khi tạo automation có `run_script` |
| `send_notification`'s `channel` model chưa rõ khớp F11 tới đâu | Thấp | Kiểm tra `docs/features/F11-notifications.md` trước khi khoá field UI, tránh 2 model channel lệch nhau |

## Không thuộc phạm vi CR này

- Executor `commit_push`/`create_pr` — xem CR-AUTO-003 (không dùng
  `STEP_TYPE_SHELL` cho commit dù về lý thuyết có thể — AGENTS.md's "Git
  Binary Compatibility" yêu cầu qua `GitCapabilityCache`/provider có
  version-fallback, không phải raw shell `git` command chạy qua
  automation, nên `commit_push` cố tình KHÔNG tái dùng `STEP_TYPE_SHELL`
  ở CR này).
- Executor `create_worktree` — gộp vào CR-AUTO-002's loop (đã có logic ở
  `headless-workspace-create.ts`).
- Thiết kế lại `channel` model của notification nếu phát hiện lệch F11 —
  nếu phát hiện khi build CR này, tách thành CR riêng, không tự ý đổi
  F11's channel model trong CR này.

## Liên quan

- `backend-go/proto/orca/workflow/v1/workflow.proto:53-58` (`StepType` enum)
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/shell_step_executor.go`
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/notification_step_executor.go`
- `agent/src/relay/agent-rpc-dispatch-misc.ts:186-210` (`shell.exec`, `notification.send` case)
- `agent/src/relay/notification-send-handler.ts`
- `agent/src/relay/__tests__/agent-rpc-dispatch.test.ts:416-459` (test hiện có, code-level only)
- `desktop/src/main/workflow/StepExecutors.ts:1-14` (bản TS song song, tham chiếu shape)
- `docs/features/F11-notifications.md` (kiểm tra channel model trước khi build UI)
- [CR-AUTO-002](./CR-AUTO-002-multi-action-chain-data-model.md) (phụ thuộc cứng)
- [CR-AUTO-003](./CR-AUTO-003-action-executors-commit-pr.md) (chia sẻ `AutomationActionConfigForm`)
