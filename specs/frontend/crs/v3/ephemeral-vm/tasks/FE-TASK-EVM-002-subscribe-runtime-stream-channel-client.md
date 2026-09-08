# FE-TASK-EVM-002: `subscribeRuntimeStreamChannel` — client generic cho `StreamChannelHandler`

**Solution:** [FE-SOL-EVM-002](../solutions/FE-SOL-EVM-002-provision-streaming-client.md) §1-2 | **CR:** CR-EVM-003
**Depends on:** [TASK-BE-EVM-005](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-005-wscompat-provision-channel.md) (DONE — channel thật đã ship, xem cập nhật bên dưới)
**Status:** ✅ DONE

## Kết quả thực tế

**Đã xong:**

- Audit (bắt buộc, mục 1 của solution) xác nhận `window.api.runtimeEnvironments.subscribe`
  (backed bởi `WebRuntimeClient`/`WebSessionClient`, cả 2 đều negotiate
  wscompat's `dialectSessionClient` — xem `session_dialect.go`) là hook
  push-by-request-id ĐÃ CÓ SẴN cho dialect này; `PushEvent.Channel`-keyed
  routing (`push_bridge.go`'s `pipePush`, `rpc-client.ts`'s
  `on(channel, handler)`) chỉ tồn tại cho `dialectNative`
  (`WebSocketRpcClient`, `frontend/src/platform/adapters/web/rpc-client.ts`)
  — client này **không hề được instantiate ở đâu trong frontend**
  (`getClientForEnvironment` chỉ trả `WebRuntimeClient | WebSessionClient`),
  nên đây là dead code, không phải hook thật đang dùng. Kết luận: tái dùng
  `window.api.runtimeEnvironments.subscribe`, không viết cơ chế push song song.
- Audit phát hiện thêm 1 gap thật trong hook có sẵn: `isSubscriptionResponse`
  (cả `web-runtime-client.ts` và `web-session-client.ts`) chỉ route
  `onResponse` cho response có `streaming:true` hoặc `result.type` là
  `'end'`/`'scrollback'` — một `StreamChannelHandler`'s ack đầu tiên
  (`registry.go`'s `DispatchStreamChannel`, ghi qua `writeDialectResult`
  KHÔNG có `streaming` flag — chỉ push event sau đó mới có, xem
  `push_bridge.go`'s `pipePushForDialect`) bị **silently dropped** nếu ack
  value không tình cờ khớp 1 trong 2 shape đó (ví dụ ack tương lai của
  `ephemeralVm.provision` dạng `{provisionId}` chắc chắn bị rớt). Đã fix cả
  2 file: `isSubscriptionResponse` giờ chỉ check `'ok' in response` (id đã
  unique-scoped vào đúng 1 trong 2 map `subscriptions`/`pending`, nên
  filter cũ là dư/sai) — verify AN TOÀN qua `gitnexus impact` (LOW risk,
  4 impacted, không process nào bị ảnh hưởng) + toàn bộ test suite hiện có
  (`web-runtime-client.test.ts`, `web-runtime-client-heartbeat.test.ts`,
  `remote-runtime-terminal-json-subscribe.test.ts`) vẫn pass — các consumer
  khác (`nativeChat.subscribe`, `files.watch`) đã có guard clause riêng nên
  nhận thêm ack event không phá gì.
- `subscribeRuntimeStreamChannel<TAck, TEvent>(target, method, params, onEvent)`
  implemented tại `frontend/src/renderer/src/runtime/runtime-rpc-client.ts`
  (cạnh `callRuntimeRpc`, không đổi hàm cũ — xác nhận qua
  `gitnexus impact({target: "callRuntimeRpc", direction: "downstream"})`,
  LOW risk). `target.kind === 'local'` reject rõ ràng (không route desktop
  path qua đây, đúng thiết kế). `target.kind === 'environment'` wrap
  `window.api.runtimeEnvironments.subscribe`: response đầu tiên = ack
  (resolve promise), các response sau = event (route vào `onEvent`);
  `unsubscribe()` có `stopped` guard cục bộ để chặn `onEvent` ngay cả khi
   transport chưa kịp reap subscription.
- Test mock đầy đủ tại `runtime-rpc-client.test.ts` (`describe('subscribeRuntimeStreamChannel', ...)`),
  cover đủ cả 4 test case yêu cầu (trừ integration thật): ack từ response
  đầu, mỗi push frame → đúng `onEvent` theo thứ tự, `unsubscribe()` chặn
  event tiếp theo, `target.kind === 'local'` reject rõ ràng. 28 test pass
  (không tính integration test).
- Verify thật: `npx vitest run src/renderer/src/runtime/runtime-rpc-client.test.ts`
  → 28 passed, 1 todo. `npx tsc --noEmit` → không có lỗi mới trong 4 file
  đã sửa (đối chiếu với baseline trước khi sửa, chỉ còn 1 lỗi TS6133 tại
  `web-session-client.ts:108` — pre-existing, không liên quan thay đổi này).

**Cập nhật (TASK-BE-EVM-005 đã ship — integration test hoàn tất):**

- Xác nhận `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go`
  giờ đã có `registerEphemeralVmProvisionChannel` gọi
  `r.RegisterStreamChannel("ephemeralVm.provision", ...)` (đọc source thật,
  không đoán).
- Audit bắt buộc trước khi viết test (theo đúng chỉ dẫn task): sweep toàn
  bộ `frontend/` test suite tìm tiền lệ 1 test JS/TS kết nối tới 1 tiến
  trình/transport backend-go THẬT cho bất kỳ `StreamChannelHandler` channel
  nào (`terminal.multiplex`, `terminal.subscribe`,
  `onboarding.openGhAuthTerminal`, ...). Kết quả: **không có tiền lệ nào**
  — kể cả case "chặt chẽ" nhất (`remote-runtime-client.test.ts`,
  `web-runtime-client.test.ts`) chỉ dùng 1 `ws` TCP loopback thật nhưng nói
  chuyện với 1 server double viết tay bằng TS giả lập giao thức wscompat,
  KHÔNG bao giờ chạy binary Go thật. Cross-process integration thật duy
  nhất trong repo là Playwright e2e ở `tests/e2e/` (root package, khác
  `frontend/` package), không phải unit-test-level client-vs-real-server.
  Không có hạ tầng mock-WS-server-đầy-đủ nào từng tồn tại trong
  `frontend/` để tái dùng.
- Vì không có tiền lệ cross-transport thật, mức hợp lý nhất (theo đúng chỉ
  dẫn) là: bỏ `it.todo`, viết test thật dùng **response mock đúng 100%
  theo wire shape THẬT** đã xác nhận qua đọc trực tiếp
  `channels_ephemeral_vm.go` + `channels_ephemeral_vm_test.go` +
  `push_bridge.go` (không phải shape giả định cũ):
  - ack: `ephemeralVmProvisionAckView`'s JSON tag `{"provisionId": "..."}`,
    không có `streaming` flag (`writeDialectResult`).
  - push event: `pipePushForDialect` bọc mỗi `PushEvent` thành
    `SessionClientResultMessage{id, ok:true, streaming:true, result:
    pushEventResult(ev)}`; `pushEventResult` unwrap `PushEvent.Args`
    (1 phần tử) thành thẳng giá trị đó — chính là
    `toEphemeralVmProvisionEventView`'s map `{provisionId, type, chunk}`
    (stdout/stderr) hoặc `{provisionId, type: 'result', result:
    toEphemeralVmProvisionResultView(...)}`.
  - Test mới (`describe('subscribeRuntimeStreamChannel', ...)`'s cuối cùng)
    drive `subscribeRuntimeStreamChannel` thật (không mock) qua đúng các
    frame trên, verify ack, 3 event theo thứ tự (stdout/stderr/result),
    và `unsubscribe()` chặn event tiếp theo.
- Verify thật: `npx vitest run src/renderer/src/runtime/runtime-rpc-client.test.ts`
  → **29 passed, 0 todo** (không còn `it.todo` nào). `npx tsc --noEmit` →
  0 lỗi mới trong file đã sửa (đối chiếu baseline trước/sau: 146 → 142 lỗi,
  đúng bằng số lỗi tạm thời tự gây ra khi soạn test rồi tự sửa hết, không
  còn sót).
- **Còn thiếu thật sự** (không thể lấp trong phạm vi task này, cần ghi
  nhận rõ): đây KHÔNG phải 1 test cross-process thật (không có backend-go
  binary/gRPC server nào chạy) — nó verify đúng shape THẬT của wire
  protocol tại đúng ranh giới `window.api.runtimeEnvironments.subscribe`,
  mức sâu nhất khả thi khi repo chưa có hạ tầng mock-WS-server/test-harness
  nào cho việc này. Một test cross-process thật (spin up backend-go +
  infra-fleet-service + agent giả) nằm ngoài phạm vi unit test của
  `frontend/` package — thuộc về Playwright e2e (`tests/e2e/`) nếu cần,
  không phải task này.

---

## Mục tiêu

Audit `WebRuntimeClient`/`IRpcClient` (TDD-FE-03's "restructure_v1
Addendum") xem đã có hook nào cho push frame theo `channel` name chưa —
nếu chưa, viết `subscribeRuntimeStreamChannel` mới trong
`runtime-rpc-client.ts`.

## Files cần sửa

1. `frontend/src/renderer/src/runtime/runtime-rpc-client.ts` (MODIFY — hàm mới)
2. `frontend/src/renderer/src/runtime/web-runtime-client.ts` hoặc `IRpcClient`'s implementation (MODIFY nếu audit xác nhận chưa có hook push-by-channel)
3. Test file tương ứng

## Nội dung (xem FE-SOL-EVM-002 §2)

```ts
export function subscribeRuntimeStreamChannel<TAck, TEvent>(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  onEvent: (event: TEvent) => void
): Promise<{ ack: TAck; unsubscribe: () => void }>
```

`target.kind === 'environment'`: mở 1 kết nối WS-message tới `method`,
ack đầu tiên nhận qua response thường, frame push sau đó (cùng `channel`
name theo `PushEvent.Channel`, `push_bridge.go:25-28`) route vào
`onEvent`. **Bước audit bắt buộc trước khi code**: đọc
`web-runtime-client.ts`/`IRpcClient`'s implementation thật — nếu đã có
cơ chế push-by-channel dùng chung (có thể `RemoteRuntimeTerminalMultiplexer`
build trên 1 layer thấp hơn có thể tái dùng một phần), tái dùng thay vì
viết song song 2 cơ chế push khác nhau.

## Test cases cần cover

- `subscribeRuntimeStreamChannel` nhận đúng `ack` từ response đầu tiên.
- Mỗi push frame khớp `channel` gọi đúng `onEvent`.
- `unsubscribe()` dừng nhận event tiếp theo (không gọi `onEvent` sau khi unsubscribe).
- `target.kind === 'local'` — xác nhận hàm này KHÔNG được gọi cho desktop path (desktop giữ nguyên `window.api`, xem FE-SOL-EVM-002 §2 — có thể là 1 test "throws/not applicable" tuỳ thiết kế cuối).
- Integration test thật với `ephemeralVm.provision` (TASK-BE-EVM-005 đã ship) — không chỉ mock server.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/runtime/runtime-rpc-client.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "callRuntimeRpc", direction: "downstream"})` — xác
nhận hàm mới không phá bất kỳ call site nào của `callRuntimeRpc` hiện có
(không đổi hàm cũ, chỉ thêm hàm mới cạnh nó).

## Blocking

[FE-TASK-EVM-003](./FE-TASK-EVM-003-runtime-ephemeral-vm-client-provision-wiring.md)
phụ thuộc task này.
