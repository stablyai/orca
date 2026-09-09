# BE-AUTO-SOL-004: Map `run_script`/`send_notification` vào `StepType` có sẵn

> **🔲 Designed — chưa implement.** Nhẹ nhất trong nhóm executor — chỉ
> mapping, không executor Go mới, không thay đổi agent.

**CR:** [CR-AUTO-004](../../../../../../docs/crs/v4/automations/CR-AUTO-004-action-executors-script-notification.md)
**Agent counterpart:** [SOL-AG-AUTO-001](../../../../agent/crs/v4/automation/solutions/SOL-AG-AUTO-001-verify-shell-notification-contract.md)
**Service:** `automation-service`
**TDD tham chiếu:** [`workflow-service.md`](../../../../tdd/services/workflow-service.md) §step executors

---

## 1. Trạng thái hiện tại

`STEP_TYPE_SHELL`/`STEP_TYPE_NOTIFICATION` đã có executor Go thật
(`shell_step_executor.go`, `notification_step_executor.go`), chạy tới
agent thật (`shell.exec`/`notification.send`, đã tồn tại — xem
SOL-AG-AUTO-001). Không thiếu gì ở tầng `workflow-service`.

## 2. Giải pháp: chỉ mapping trong `dispatch()`

```go
// execute_automation_chain.go (BE-AUTO-SOL-002)
case AUTOMATION_ACTION_TYPE_RUN_SCRIPT:
    return e.workflowClient.ExecuteAdHocStep(ctx, workflowv1.StepType_STEP_TYPE_SHELL, action.ConfigJson)
case AUTOMATION_ACTION_TYPE_SEND_NOTIFICATION:
    return e.workflowClient.ExecuteAdHocStep(ctx, workflowv1.StepType_STEP_TYPE_NOTIFICATION, action.ConfigJson)
```

`action.ConfigJson`'s shape giữ nguyên `{script, env}`/`{channel, message}`
đã định nghĩa ở `shellStepExecutor`/`notificationStepExecutor` — không
đổi contract.

## 3. Điều kiện tiên quyết trước khi coi solution này "sẵn sàng ship"

Phụ thuộc **SOL-AG-AUTO-001** xong (verify end-to-end thật, đóng caveat
"not verified against a live Dev Server Agent") — nếu SOL-AG-AUTO-001
phát hiện `notification.send`'s response thiếu field `error`, cần sửa
`notificationResult` (Go) hoặc `notification-send-handler.ts` (agent)
**trước khi** bật `send_notification` action cho user thật, tránh lỗi
gửi thông báo thất bại âm thầm qua automation tự động (rủi ro cao hơn
notification thủ công vì không ai đang nhìn để nhận ra thất bại).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng BE-AUTO-SOL-002 | Cao | Cần dispatch loop tồn tại |
| Phụ thuộc SOL-AG-AUTO-001 xong trước khi ship `send_notification` cho user | Trung bình | Xem mục 3 |
| `run_script` chạy shell tuỳ ý theo lịch tự động | Trung bình-Cao | Cùng class rủi ro đã nêu ở `docs/crs/v4/automations/README.md`'s "Rủi ro chung" |

## Không thuộc phạm vi solution này

- `commit_push`/`create_pr` — xem [BE-AUTO-SOL-003](./BE-AUTO-SOL-003-action-executors-commit-pr.md) (cần step type mới, không tái dùng được).

## Liên quan

- `backend-go/proto/orca/workflow/v1/workflow.proto:53-58`
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/shell_step_executor.go`
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/notification_step_executor.go`
- [BE-AUTO-SOL-002](./BE-AUTO-SOL-002-multi-action-chain-data-model.md) (phụ thuộc cứng)
- [SOL-AG-AUTO-001](../../../../agent/crs/v4/automation/solutions/SOL-AG-AUTO-001-verify-shell-notification-contract.md) (điều kiện tiên quyết trước khi ship)
