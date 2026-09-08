# TASK-AG-EVM-003: Wire `vm.provision`/`vm.cancelProvision` vào dispatch

**Solution:** [SOL-AG-EVM-002](../solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md) §4 | **CR:** CR-EVM-003
**Depends on:** [TASK-AG-EVM-002](./TASK-AG-EVM-002-vm-provision-streaming-handler.md)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Đăng ký `vm.provision` (không có response frame đơn, theo convention
`git.execStream`) và `vm.cancelProvision` (request/response bình
thường) vào `agent-rpc-dispatch-misc.ts`, cộng validate params.

## Files cần sửa

1. `agent/src/relay/agent-rpc-dispatch-misc.ts` (MODIFY — 2 case mới)
2. `agent/src/relay/agent-rpc-dispatch-misc.test.ts` (MODIFY — test dispatch, nếu file test tương ứng đã tồn tại; nếu không, thêm vào file test dispatch chung)

## Nội dung (xem SOL-AG-EVM-002 §4)

```ts
case 'vm.provision': {
  const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
  await handleVmProvision(ws, wireState, rpc.id, validateVmProvisionParams(rpc.params))
  return   // không set `response` — không gửi frame response đơn
}
case 'vm.cancelProvision': {
  const { handleVmCancelProvision } = await import('./agent-ephemeral-vm-handler')
  response = await handleVmCancelProvision(validateRuntimeIdParam(rpc.params))
  break
}
```

`validateVmProvisionParams`/`validateRuntimeIdParam` theo đúng convention
`requiredString` đã dùng ở các case khác trong cùng file (`repoPath`,
`command`, `recipeId`, `runtimeId` bắt buộc; `runtimeId` bắt buộc riêng
cho `cancelProvision`).

## Test cases cần cover

- `case 'vm.provision'` với params hợp lệ → gọi `handleVmProvision` với đúng `ws`/`wireState`/`rpc.id`/params đã validate, dispatch loop KHÔNG gửi thêm response frame nào (khác mọi case khác trong file).
- `case 'vm.provision'` với params thiếu field → lỗi validate trước khi gọi `handleVmProvision`, KHÔNG mở process con nào (mock `runRecipeCommand`, xác nhận không được gọi).
- `case 'vm.cancelProvision'` với params hợp lệ → gọi đúng `handleVmCancelProvision`, `response` set bình thường (theo dispatch loop convention chung).

## Verify

```bash
cd agent && npx vitest run src/relay/agent-rpc-dispatch-misc.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "route", direction: "downstream"})` hoặc tương đương
tên hàm dispatch chính thật (xác nhận tên hàm — TDD-AG-07 gọi là
`route()`, mã nguồn thật có thể đặt tên khác do file đã tách, xem
README's "Cảnh báo TDD lỗi thời") — xác nhận không phá case nào khác
trong cùng switch-statement lớn.

## Blocking

Không task agent nào khác phụ thuộc task này. Backend-go
([TASK-BE-EVM-003](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-003-devserveragent-stream-vm-provision.md))
cần `vm.provision` tồn tại thật để test integration đầy đủ (không chỉ
mock agent).

---

## ✅ Kết quả thực tế (2026-09-08)

**Lệch quan trọng so với sketch (2 điểm — đều đã xác nhận qua đọc source
thật, đúng cảnh báo bắt buộc của task/README's "Cảnh báo TDD lỗi thời"):**

1. **`case 'vm.provision'` KHÔNG "no response frame"** — sketch (và
   SOL-AG-EVM-002 §4, trích TDD-AG-07 dòng 154-157 "No single response
   frame") khẳng định `vm.provision` không set response, `return` trơn.
   Đọc source thật `agent-rpc-dispatch-git.ts`'s `case 'git.execStream'`
   (mẫu duy nhất hiện có cho streaming case, xác nhận qua Explore agent)
   cho thấy điều ngược lại: `dispatchGitRpc` **fire-and-forget** gọi
   `handleGitExecStream` (`void handleGitExecStream(...)`, không await) rồi
   **return ngay 1 response `{jsonrpc:'2.0', id, result:{type:
   'stream.started'}}`** — đây chính là "response frame đơn" mà sketch nói
   không tồn tại. `case 'vm.provision'` viết theo đúng mẫu thật này (fire
   `handleVmProvision` bằng `void`, return `stream.started`), không theo
   sketch. Đây là 1 ví dụ cụ thể của README's cảnh báo TDD-AG-07 lỗi thời.
2. **`dispatchMiscRpc` thiếu tham số `state: WireState`** — không nằm
   trong sketch/"Files cần sửa" gốc (chỉ liệt `agent-rpc-dispatch-misc.ts`
   + test). Đọc source thật: `dispatchMiscRpc(rpc, tools, config, log, ws)`
   — không có `state`, khác `dispatchGitRpc(rpc, config, log, ws, state)`
   (dispatch file duy nhất khác cũng cần streaming). Vì `handleVmProvision`
   cần `WireState` để gọi `sendFrame`, đã **thêm tham số `state: WireState`
   thứ 6 vào `dispatchMiscRpc`** và cập nhật DUY NHẤT 1 call site của nó —
   `route()` trong `agent-rpc-dispatch.ts` (dòng
   `dispatchMiscRpc(rpc, tools, config, log, ws)` →
   `dispatchMiscRpc(rpc, tools, config, log, ws, state)`). Xác nhận trước
   khi sửa qua `impact({target:"route", direction:"upstream",
   file_path:"agent/src/relay/agent-rpc-dispatch.ts"})` → risk LOW, đúng 1
   caller (`dispatch` method trong cùng file) — an toàn để đổi. File
   `agent-rpc-dispatch.ts` do đó nằm ngoài "Files cần sửa" gốc của task
   nhưng là thay đổi tối thiểu, cần thiết, không thể tránh.

**gitnexus impact:** `impact({target:"route", direction:"upstream",
repo:"orca", file_path:"agent/src/relay/agent-rpc-dispatch.ts"})` → risk
LOW, 1 caller trực tiếp (`dispatch`). Dùng `route`/`file_path` thay vì tên
hàm dispatch chung `dispatchMiscRpc` — target đó gitnexus không tìm thấy
(index có thể chưa reanalyze theo state code mới nhất); `route` là tên
hàm dispatch chính thật (đúng README's cảnh báo TDD-AG-07's `route()` bị
coi là tên lỗi thời — thực ra tên đó ĐÚNG với source thật, chỉ là
`agent-rpc-dispatch.ts` đã tách switch lớn thành các file domain, `route`
vẫn còn và vẫn là hàm gọi các `dispatchXxxRpc`).

**Test:** `npx vitest run src/relay/__tests__/agent-rpc-dispatch.test.ts
src/relay/agent-ephemeral-vm-handler.test.ts
src/relay/agent-rpc-dispatch-misc.test.ts` → **80/80 pass** — bao gồm
`agent-rpc-dispatch.test.ts` (không sửa file test này, xác nhận thay đổi
`route()`'s call site không phá test nào có sẵn). `agent-rpc-dispatch-misc.test.ts`
có 8 test (2 connection.teardown + 3 vm.exec + 2 vm.provision + 1
vm.cancelProvision), cover đủ mọi test case yêu cầu: `vm.provision` params
hợp lệ → gọi `handleVmProvision` đúng `ws`/`state`/`rpc.id`/params,
KHÔNG await handler (assert bằng promise chưa resolve), trả đúng
`stream.started`; params thiếu field → lỗi validate trước, không gọi
`handleVmProvision`; `vm.cancelProvision` params hợp lệ → response bình
thường theo convention chung.

**tsc --noEmit:** cùng 51 lỗi tiền tồn tại như TASK-001/002 (không liên
quan), không có lỗi nào trong các file đã sửa của task này
(`agent-rpc-dispatch-misc.ts`, `agent-rpc-dispatch.ts`,
`agent-ephemeral-vm-handler.ts`, và cả 2 file test).

**Files đã sửa (khác "Files cần sửa" gốc — có `agent-rpc-dispatch.ts`,
lý do ở mục lệch #2 trên):**
- `agent/src/relay/agent-rpc-dispatch-misc.ts` (MODIFY — thêm tham số
  `state`, 2 case mới `vm.provision`/`vm.cancelProvision`)
- `agent/src/relay/agent-rpc-dispatch-misc.test.ts` (MODIFY — thêm `state`
  vào mọi call site `dispatchMiscRpc` có sẵn, thêm 2 describe block mới)
- `agent/src/relay/agent-rpc-dispatch.ts` (MODIFY — 1 dòng, truyền `state`
  vào `dispatchMiscRpc` ở `route()`)
