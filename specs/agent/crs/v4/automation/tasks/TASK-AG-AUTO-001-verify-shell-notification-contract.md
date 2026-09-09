# TASK-AG-AUTO-001: Integration test — `shell.exec`/`notification.send` contract thật

**Solution:** [SOL-AG-AUTO-001](../solutions/SOL-AG-AUTO-001-verify-shell-notification-contract.md) | **CR:** CR-AUTO-004
**Depends on:** Không
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Verify end-to-end `ExecuteAdHocStep` (backend-go, `STEP_TYPE_SHELL`/
`STEP_TYPE_NOTIFICATION`) → `infra-fleet-service` relay → agent thật —
đóng caveat "Best-effort, not verified against a live Dev Server Agent"
mà `shell_step_executor.go:14-16`/`notification_step_executor.go:12-14`
tự ghi nhận. Không sửa handler agent nếu contract khớp.

## Files cần sửa

1. `agent/src/relay/__tests__/agent-rpc-dispatch-integration.test.ts` (MỚI, hoặc tên khác nếu convention harness khác — xem bước 1)
2. Có thể cần sửa `notification-send-handler.ts` HOẶC
   `backend-go/services/workflow-service/internal/adapter/infrafleetclient/notification_step_executor.go`
   NẾU phát hiện lệch field (xem bước 3) — không sửa trước khi có bằng
   chứng.

## Bước 1 — Tìm/tái dùng test harness

Đọc `agent/src/relay/agent-rpc-dispatch-vm.test.ts` (dùng cho
CR-EVM-001, đã Done) để xác nhận cách nó khởi tạo 1 "agent instance" cho
test — tái dùng helper đó nếu tồn tại, không viết harness mới trùng lặp.

## Bước 2 — Test `shell.exec`

- Gửi `shell.exec` với `{script, env}` hợp lệ qua dispatch thật.
- Assert response shape khớp `execResult`
  (`backend-go/.../exec_result.go`) mà `ShellExecutor` decode —
  đọc field thật ở cả 2 phía trước khi viết assertion.

## Bước 3 — Test `notification.send` (trọng tâm — rủi ro cao nhất)

- Gửi `notification.send` với `{channel, message}` hợp lệ.
- Assert response có field `error` (hoặc tương đương) mà
  `notificationResult.Error` (Go) decode được — theo SOL-AG-AUTO-001 mục
  2, nghi ngờ chính: agent's response có thể KHÔNG mang field lỗi thật
  (fire-and-forget, luôn "thành công"). Nếu xác nhận đúng nghi ngờ này:
  - Không tự sửa trong task này — ghi lại phát hiện cụ thể (response
    shape thật, field nào thiếu) vào kết quả task, báo lên
    BE-AUTO-SOL-004's "Điều kiện tiên quyết" (mục 3) làm gate trước khi
    `send_notification` action được ship cho user thật.

## Verify

```bash
cd agent && npx vitest run src/relay/__tests__/agent-rpc-dispatch-integration.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "handleShellExec"})`/tương đương trước khi động vào
bất kỳ handler nào (chỉ nếu bước 3 phát hiện cần sửa).

## Kết quả cần ghi lại (khi hoàn thành)

- Bảng field-by-field so khớp thật (không chỉ "pass"/"fail") cho cả 2
  RPC, đặc biệt cột `notification.send`'s response — đây là input trực
  tiếp cho quyết định "có bật `send_notification` action cho user" ở
  BE-AUTO-SOL-004.

---

## ✅ Kết quả thực tế (2026-09-09)

**Lệch so với sketch gốc**: không cần harness "1 agent instance thật"
riêng — phát hiện `agent-rpc-dispatch.test.ts`'s test `shell.exec`/
`notification.send` (dòng ~416-459) **đã chạy handler thật, không mock**
(`createRpcDispatcher` + `dispatch()` thật, `shell.exec` spawn `sh -c`
thật, `notification.send` gọi `tryOsNotify` thật) — đây chính xác là
"live agent" theo nghĩa business logic thật thực thi, chỉ khác live
process theo network. Tái dùng harness có sẵn, không viết mới.

### Bảng so khớp field-by-field (thật, đọc source cả 2 phía)

| RPC | Agent response thật (`result`) | Go decode (`execResult`/`notificationResult`) | Kết luận |
|---|---|---|---|
| `shell.exec` | `{stdout, stderr, exitCode, truncated?}` — **không bao giờ có `error`** (`fs-agent-extensions.ts:584-587`) | `{ExitCode *int, Stdout, Stderr, Error}` | ✅ AN TOÀN — Go's `toStepResult` dùng `ExitCode != 0` làm điều kiện fail chính, `Error` rỗng không gây sai lệch vì agent luôn gửi đúng `exitCode` thật |
| `notification.send` | `{ok:true, delivered: bool, note}` — **không bao giờ có `error` trong `result`**, và **`delivered:false` vẫn trả `ok:true`** (`notification-send-handler.ts:70-77`) | `{Error string}` | ❌ **XÁC NHẬN ĐÚNG NGHI NGỜ** — Go không có field nào đọc được `delivered`, chỉ đọc `Error` (luôn rỗng) → `NotificationExecutor` **luôn báo `completed`**, kể cả khi *không ai* nhận được thông báo |

### Đây là hành vi CÓ CHỦ ĐÍCH của agent, không phải bug

`notification-send-handler.ts`'s doc comment tự ghi rõ: "Delivery failure
is never fatal — a notification step should not fail a workflow run" —
vì dev server thường headless (comment: "no desktop session in the
common case"), coi delivery-fail là lỗi cứng sẽ làm feature vô dụng
trong trường hợp phổ biến nhất. **Không sửa trong task này** — sửa sẽ đi
ngược thiết kế có chủ đích của agent, là quyết định sản phẩm lớn hơn
phạm vi 1 task verify.

**Xác nhận thật trong sandbox này** (không giả lập): `notify-send` và
`osascript` đều KHÔNG có trên PATH — tức `tryOsNotify` chắc chắn fail
thật, đúng kịch bản "headless dev server" cần test.

### Kết luận cho BE-AUTO-SOL-004 / TASK-BE-AUTO-007

`shell.exec` — an toàn, không cần thay đổi gì. `send_notification` — code
mapping đã đúng và an toàn về mặt kỹ thuật (không throw, không crash),
nhưng **không đáng tin cậy như 1 cơ chế "báo cho người dùng biết"** trên
dev server headless — automation `send_notification` sẽ luôn báo
"completed" dù không ai nhận được gì. Đây là giới hạn cần ghi vào UI
(FE-AUTO-SOL-004) khi hiển thị action này, không phải lỗi cần fix ở
tầng agent/backend-go.

**Test mới**: 1 test trong `agent-rpc-dispatch.test.ts`'s `notification.send`
describe block, assert cụ thể `ok:true`, `delivered:false`,
`result.error` `undefined` — khoá lại hành vi đã xác nhận, không chỉ mô
tả bằng lời.

**Verify**: `npx vitest run src/relay/__tests__/agent-rpc-dispatch.test.ts`
— 45/45 pass (44 cũ + 1 mới). `npx tsc --noEmit` — 0 lỗi.

**Files đã sửa:**
- `agent/src/relay/__tests__/agent-rpc-dispatch.test.ts` (MODIFY — thêm 1 test)
