# FE-SOL-EVM-002: Client-side streaming cho `ephemeralVm.provision`/`cancelProvision`

> **🔲 Designed — chưa implement. Phụ thuộc cứng**
> [BE-SOL-EVM-002](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-002-provision-streaming-channel.md)
> (backend-go) và
> [SOL-AG-EVM-002](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md)
> (agent).

**CR:** [CR-EVM-003](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-003-provision-streaming-rpc.md)
**backend-go counterpart:** [BE-SOL-EVM-002](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-002-provision-streaming-channel.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2 (`callRuntimeRpc`, xác nhận KHÔNG hỗ trợ streaming — xem mục 1), §6 (`RemoteRuntimeTerminalMultiplexer`, precedent gần nhất nhưng không tái dùng trực tiếp được)

---

## 1. Không có generic streaming client sẵn — cần viết mới

Đọc trực tiếp `runtime-rpc-client.ts:68-` (không chỉ tin TDD-FE-03 §2)
xác nhận `callRuntimeRpc<TResult>(...): Promise<TResult>` là
request/response thuần — không có cơ chế subscribe vào `PushEvent` mà
`Registry.StreamChannelHandler` (backend-go) phát ra sau khi ack.
`RemoteRuntimeTerminalMultiplexer` (TDD-FE-03 §6,
`remote-runtime-terminal-multiplexer.ts`) là streaming client duy nhất
hiện có, nhưng xử lý **binary opcode-tagged frame** riêng của
`terminal.multiplex` — không phải JSON `PushEvent` generic mà
`ephemeralVm.provision` cần.

## 2. Thiết kế: `subscribeRuntimeStreamChannel` — client generic mới

Vì đây là hạ tầng dùng chung tiềm năng cho mọi `StreamChannelHandler`
channel tương lai (không chỉ `ephemeralVm.provision`), thiết kế 1 hàm
generic ở `runtime-rpc-client.ts` (mở rộng file đã có, không tạo layer
mới):

```ts
// runtime-rpc-client.ts (bổ sung)
export function subscribeRuntimeStreamChannel<TAck, TEvent>(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  onEvent: (event: TEvent) => void
): Promise<{ ack: TAck; unsubscribe: () => void }>
```

Với `target.kind === 'local'` (desktop): route qua `window.api.ephemeralVm.provision`
cũ (broadcast IPC event `ephemeralVm:provisionEvent` —
KHÔNG đổi hành vi desktop hiện có, xem "Không thuộc phạm vi"). Với
`target.kind === 'environment'` (web/paired): mở 1 kết nối WS-message
tới cùng `method`, ack đầu tiên nhận qua response thường, các frame push
sau đó (cùng `channel` name theo `PushEvent.Channel`, xem
`push_bridge.go:25-28`) route vào `onEvent`.

## 3. `runtime-ephemeral-vm-client.ts` — route `provision`/`cancelProvision`

```ts
// runtime-ephemeral-vm-client.ts (bổ sung, theo đúng khuôn 9 hàm đã có)
export function provisionRuntimeEphemeralVmWorkspace(
  target: RuntimeClientTarget,
  args: { recipeId: string; runtimeId: string; connectionId: string },
  onEvent: (event: EphemeralVmProvisionEvent) => void
): Promise<{ ack: { provisionId: string }; unsubscribe: () => void }> {
  if (target.kind === 'local') {
    return subscribeDesktopProvisionBroadcast(args, onEvent)   // window.api, giữ nguyên
  }
  return subscribeRuntimeStreamChannel(target, 'ephemeralVm.provision', args, onEvent)
}

export function cancelRuntimeEphemeralVmProvision(
  target: RuntimeClientTarget, provisionId: string
): Promise<{ cancelled: boolean }> {
  if (target.kind === 'local') {
    return window.api.ephemeralVm.cancelProvision(provisionId)
  }
  return callRuntimeRpc(target, 'ephemeralVm.cancelProvision', { provisionId })   // request/response bình thường, không streaming
}
```

## 4. UI consumption — không thiết kế chi tiết ở solution này

Việc UI nào gọi `provisionRuntimeEphemeralVmWorkspace` (settings panel?
worktree-creation flow?) và hiển thị log stdout/stderr realtime như thế
nào **không thuộc phạm vi solution này** — đây là phần "client layer"
(TDD-FE-03's phạm vi), không phải component UI (TDD-FE-05). Cần 1
solution/task riêng khi có UI cụ thể muốn dùng `provision`.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng BE-SOL-EVM-002 + SOL-AG-EVM-002 | Cao nếu làm trước | Không có gì để test/gọi nếu backend-go/agent chưa ship |
| WS-message-level "subscribe vào push event của 1 lời gọi" — cơ chế client thật cần audit trước | Trung bình-Cao | Cần xác nhận `WebRuntimeClient`/`IRpcClient` (TDD-FE-03's Addendum, mục "restructure_v1") có hook nào cho push frame theo `channel` name hay cần thêm — không giả định đã có, đọc `web-runtime-client.ts`/`IRpcClient` trước khi implement mục 2 |
| Desktop path (`window.api.ephemeralVm.provision`) không đổi | Thấp | Cố ý — solution này chỉ thêm nhánh web/paired, không đụng hành vi desktop hiện có (đã hoạt động qua broadcast IPC riêng) |

## Không thuộc phạm vi solution này

- Đổi cơ chế `provision`/`cancelProvision` trên desktop (`window.api.*`,
  broadcast `ephemeralVm:provisionEvent`) — giữ nguyên, chỉ thêm nhánh
  web/paired.
- UI hiển thị log provision realtime — xem mục 4.
- Backend-go/agent implementation — xem
  [BE-SOL-EVM-002](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-002-provision-streaming-channel.md)/
  [SOL-AG-EVM-002](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md).

## Liên quan

- `frontend/src/renderer/src/runtime/runtime-rpc-client.ts:68-`
- `frontend/src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts` (precedent streaming, khác protocol)
- `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:1-109`
- `backend-go/services/api-gateway/internal/adapter/wscompat/push_bridge.go:25-28` (`PushEvent` shape phía server)
- `specs/frontend/tdd/v5/03-runtime-client-layer.md` §2, §6, "restructure_v1 Addendum" (IRpcClient)
- [FE-SOL-EVM-001](./FE-SOL-EVM-001-remove-stale-suppressor-and-routing-audit.md)
