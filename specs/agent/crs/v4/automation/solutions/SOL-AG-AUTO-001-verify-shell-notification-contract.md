# SOL-AG-AUTO-001: Verify `shell.exec`/`notification.send` contract end-to-end

> **🔲 Designed — chưa implement.** Không viết handler mới — cả 2 RPC đã
> tồn tại thật ở agent. Solution này chỉ đóng 1 caveat "chưa từng verify"
> mà chính backend-go's executor code tự ghi nhận.

**CR:** [CR-AUTO-004](../../../../../../docs/crs/v4/automations/CR-AUTO-004-action-executors-script-notification.md)
**backend-go counterpart:** [BE-AUTO-SOL-004](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-004-action-executors-script-notification.md)
**TDD tham chiếu:** [TDD-AG-07](../../../../tdd/v5/07-jsonrpc-dispatch.md) §1 (JSON-RPC Method Router — case đã tồn tại, không thêm case mới)

---

## 1. Xác nhận nguyên liệu — không viết lại

`agent/src/relay/agent-rpc-dispatch-misc.ts:186-210` đã có:

```ts
case 'shell.exec': { /* ... */ }        // dòng 188
case 'notification.send': { /* ... */ } // dòng 203
```

Cả 2 đều có test đơn vị (`agent-rpc-dispatch.test.ts:416-459`) xác nhận
shape params/response ở **phía agent**. Phía `backend-go`, 2 executor
tương ứng (`shell_step_executor.go`, `notification_step_executor.go`) tự
ghi chú "Best-effort, not verified against a live Dev Server Agent" —
nghĩa là 2 phía chưa từng được test nối với nhau thật, chỉ khớp nhau qua
đọc code 2 bên.

## 2. Việc cần làm: 1 test tích hợp thật

Không sửa `agent-rpc-dispatch-misc.ts`. Thêm 1 test **tích hợp** (không
phải unit test có fake ở 1 phía) chạy: `ExecuteAdHocStep` (backend-go,
`step_type: STEP_TYPE_SHELL`/`STEP_TYPE_NOTIFICATION`) → `infra-fleet-service`
relay → **1 instance agent thật** (không mock) → assert response khớp
`domain.StepResult` mà `ShellExecutor`/`NotificationExecutor` decode.

Test harness: tái dùng pattern agent test harness mà nhóm CR-EVM's
CR-EVM-001 (`SOL-AG-EVM-001`, đã Done) dùng khi verify `vm.exec` — không
tạo test harness mới nếu 1 cái tương tự đã tồn tại cho mục đích đó (kiểm
tra `agent-rpc-dispatch-vm.test.ts`'s cách khởi tạo agent giả lập trước
khi viết test mới, tái dùng helper nếu có).

Điểm cần verify cụ thể (khớp field, không chỉ "gọi được"):

| Field | Agent gửi/nhận (`agent-rpc-dispatch-misc.ts`) | Go decode (`shell_step_executor.go`/`notification_step_executor.go`) |
|---|---|---|
| `shell.exec` params | `{script, env}` | `shellExecParams{Script, Env}` |
| `shell.exec` response | (đọc `agent-rpc-dispatch-misc.ts:188-` để xác nhận shape thật) | `execResult` (`exec_result.go`) |
| `notification.send` params | `{channel, message}` | `notificationSendParams{Channel, Message}` |
| `notification.send` response | (đọc `notification-send-handler.ts` để xác nhận shape thật — TS's `executeNotification()` "never inspects its relay result... always returns exitCode: 0", theo `notification_step_executor.go`'s comment) | `notificationResult{Error}` — **giả định 1 field `error` tồn tại, chưa verify** |

Dòng cuối bảng là rủi ro cụ thể nhất: nếu agent's `notification.send`
response thật sự **không có** field `error` (theo đúng mô tả TS
"fire-and-forget, luôn exitCode 0"), Go's `notificationResult.Error`
luôn rỗng — `NotificationExecutor` sẽ không bao giờ báo lỗi thật, kể cả
khi gửi thất bại. Đây chính xác loại lỗi mà test tích hợp cần bắt được.

## 3. Nếu phát hiện lệch field

Không tự ý sửa 1 phía để khớp phía kia trong solution này — nếu phát
hiện lệch, ghi nhận thành 1 CR/bug riêng (phạm vi nhỏ, dễ ước lượng sau
khi có bằng chứng cụ thể), không đoán trước khi có test thật xác nhận.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `notification.send`'s response shape có thể không mang được lỗi thật (mục 2) | Trung bình | Đây là lý do chính cần verify trước khi CR-AUTO-004 coi `send_notification` là "sẵn sàng dùng" |
| Cần 1 agent instance thật cho test, không dùng fake | Thấp | Effort nhỏ nếu harness từ CR-EVM-001 tái dùng được |

## Không thuộc phạm vi solution này

- Bất kỳ handler mới nào — không có, xem README's kết luận.
- Wiring `run_script`/`send_notification` vào automation action chain —
  xem [BE-AUTO-SOL-002](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-002-multi-action-chain-data-model.md)/[004](../../../../backend-go/crs/v4/automations/solutions/BE-AUTO-SOL-004-action-executors-script-notification.md).

## Liên quan

- `agent/src/relay/agent-rpc-dispatch-misc.ts:186-210`
- `agent/src/relay/notification-send-handler.ts`
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/shell_step_executor.go`
- `backend-go/services/workflow-service/internal/adapter/infrafleetclient/notification_step_executor.go`
- `agent/src/relay/agent-rpc-dispatch-vm.test.ts` (harness tham chiếu, từ SOL-AG-EVM-001)
