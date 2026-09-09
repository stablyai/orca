# TASK-BE-AUTO-007: `run_script`/`send_notification` — mapping trong `dispatch()`

**Solution:** [BE-AUTO-SOL-004](../solutions/BE-AUTO-SOL-004-action-executors-script-notification.md) | **CR:** CR-AUTO-004
**Depends on:** [TASK-BE-AUTO-004](./TASK-BE-AUTO-004-execute-automation-chain-usecase.md), [TASK-AG-AUTO-001](../../../../agent/crs/v4/automation/tasks/TASK-AG-AUTO-001-verify-shell-notification-contract.md)
**Status:** ✅ DONE (2026-09-09) — TASK-AG-AUTO-001 đã xác nhận contract, xem ghi chú dưới

---

## Mục tiêu

Map 2 action type sang `StepType` đã có executor thật — không executor
mới.

## Điều kiện tiên quyết

**Không merge task này cho tới khi TASK-AG-AUTO-001 xác nhận
`notification.send`'s response contract** (đặc biệt: có field lỗi thật
hay luôn "thành công"). Nếu TASK-AG-AUTO-001 phát hiện lệch, sửa đó
trước, quay lại task này sau.

## Files cần sửa

1. `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY)
2. Test tương ứng

## Nội dung

```go
case AUTOMATION_ACTION_TYPE_RUN_SCRIPT:
    return e.workflowClient.ExecuteAdHocStep(ctx, workflowv1.StepType_STEP_TYPE_SHELL, action.ConfigJson)
case AUTOMATION_ACTION_TYPE_SEND_NOTIFICATION:
    return e.workflowClient.ExecuteAdHocStep(ctx, workflowv1.StepType_STEP_TYPE_NOTIFICATION, action.ConfigJson)
```

## Test cases cần cover

- `run_script` action → gọi `ExecuteAdHocStep` với `STEP_TYPE_SHELL` và `config_json` pass-through nguyên vẹn.
- `send_notification` action → tương tự với `STEP_TYPE_NOTIFICATION`.

## Verify

```bash
cd backend-go/services/automation-service && go test ./internal/usecase/...
```

## gitnexus

`impact({target: "ExecuteAdHocStep", direction: "upstream"})` — xác nhận
không phá caller khác (workflow-service tự có caller riêng ngoài
automation).

---

## 🟡 Kết quả thực tế (2026-09-09) — PARTIAL

**Phát hiện khi bắt đầu task này**: mapping `RUN_SCRIPT`/`SEND_NOTIFICATION`
→ `StepTypeShell`/`StepTypeNotification` **đã tồn tại sẵn** trong
`execute_automation_chain.go`'s `dispatch()` từ TASK-BE-AUTO-004 (2
action type này không cần `StepType` mới như `commit_push`, nên được
wire luôn từ đầu, không phải chờ TASK-BE-AUTO-005/006 như sketch ban
đầu giả định). Task này do đó chỉ còn 2 việc thật:
1. Sửa 1 doc comment lỗi thời trong `dispatch()` (liệt cả `COMMIT_PUSH`/
   `CREATE_PR` vào nhóm "not yet implemented" dù đã xong từ 005/006).
2. Thêm test **xác nhận rõ ràng** đúng `StepType` cho từng action type —
   trước đây chỉ được test gián tiếp qua các test multi-action-chain,
   không assert cụ thể `StepType` nào được gửi.

**Điều kiện tiên quyết ĐÃ HOÀN THÀNH**: TASK-AG-AUTO-001 xác nhận —
`shell.exec` an toàn (exitCode-based, không cần field `error`); `notification.send`
**có gap thật nhưng CÓ CHỦ ĐÍCH** (agent luôn báo `ok:true` kể cả
`delivered:false` — thiết kế "delivery failure never fatal" cho dev
server headless, không phải bug). Kết luận: mapping vẫn AN TOÀN để bật
thật (không crash, không lỗi sai lệch nghiêm trọng), nhưng
`send_notification` cần 1 dòng cảnh báo trong UI (FE-AUTO-SOL-004) rằng
đây không phải kênh thông báo đáng tin cậy 100% trên dev server headless
— đã ghi rõ trong TASK-AG-AUTO-001's kết quả thực tế.

**Test mới**: `TestExecuteAutomationChain_RunScript_DispatchesWithStepTypeShell`,
`TestExecuteAutomationChain_SendNotification_DispatchesWithStepTypeNotification`
— assert đúng `StepType` gửi cho từng action.

**Verify**: `go build`/`go vet` sạch. `go test
./services/automation-service/internal/usecase/...` — toàn bộ pass, gồm
2 test mới.

**Files đã sửa:**
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain.go` (MODIFY — sửa doc comment lỗi thời)
- `backend-go/services/automation-service/internal/usecase/execute_automation_chain_test.go` (MODIFY — 2 test mới)
