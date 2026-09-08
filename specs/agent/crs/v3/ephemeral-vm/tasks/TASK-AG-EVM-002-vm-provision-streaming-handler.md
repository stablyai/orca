# TASK-AG-EVM-002: `handleVmProvision` — streaming exec (mode `create`)

**Solution:** [SOL-AG-EVM-002](../solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md) §2-3 | **CR:** CR-EVM-003
**Depends on:** [TASK-AG-EVM-001](./TASK-AG-EVM-001-vm-exec-handler.md)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Mở rộng `agent-ephemeral-vm-handler.ts` với `handleVmProvision` — chạy
recipe's `create` command, đẩy `stream.chunk`/`stream.end` frame (tái
dùng khuôn `git.execStream`), hỗ trợ hủy qua `AbortController` + giới
hạn thời lượng.

## Files cần sửa

1. `agent/src/relay/agent-ephemeral-vm-handler.ts` (MODIFY — thêm `handleVmProvision`, `handleVmCancelProvision`, `provisionAbortRegistry`)
2. `agent/src/relay/agent-ephemeral-vm-handler.test.ts` (MODIFY — thêm test cho provision)

## Nội dung (xem SOL-AG-EVM-002 §2-3 cho code đầy đủ)

```ts
export type VmProvisionParams = { repoPath: string; command: string; recipeId: string; runtimeId: string }

const provisionAbortRegistry = new Map<string, AbortController>()
const DEFAULT_PROVISION_TIMEOUT_MS = 15 * 60 * 1000   // 15 phút mặc định

export async function handleVmProvision(
  ws: WebSocket, wireState: WireState, id: string | number, params: VmProvisionParams
): Promise<void> {
  const controller = new AbortController()
  provisionAbortRegistry.set(params.runtimeId, controller)
  const timeout = setTimeout(() => controller.abort(), DEFAULT_PROVISION_TIMEOUT_MS)
  try {
    const result = await runRecipeCommand({
      command: params.command, repoPath: params.repoPath, mode: 'create',
      context: { recipeId: params.recipeId, instanceId: params.runtimeId, repoPath: params.repoPath },
      signal: controller.signal,
      onStdout: (chunk) => sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.chunk', line: chunk } }),
      onStderr: (chunk) => sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.chunk', line: chunk, source: 'stderr' } })
    })
    const parsed = parseEphemeralVmRecipeResult(result.stdout)
    sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.end', exitCode: result.exitCode, provisionResult: parsed } })
  } catch (error) {
    sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.end', exitCode: -1, error: String(error) } })
  } finally {
    clearTimeout(timeout)
    provisionAbortRegistry.delete(params.runtimeId)
  }
}

export async function handleVmCancelProvision(params: { runtimeId: string }): Promise<{ cancelled: boolean }> {
  const controller = provisionAbortRegistry.get(params.runtimeId)
  if (!controller) return { cancelled: false }
  controller.abort()
  return { cancelled: true }
}
```

**Trước khi implement**: xác nhận chữ ký chính xác `sendFrame`/`WireState`
ở `agent-git-handler.ts`/`protocol.ts` (rủi ro đã ghi ở SOL-AG-EVM-002) —
tên tham số trong sketch trên là suy đoán theo pattern, không phải đọc
trực tiếp.

## Test cases cần cover

- `handleVmProvision` gửi đúng thứ tự frame: N × `stream.chunk` rồi 1 × `stream.end`, cùng `id`.
- `stream.end.provisionResult` parse đúng cả nhánh `orca-server`/`ssh`.
- `command` exit non-zero → `stream.end.exitCode` khớp, không throw ra ngoài dispatch loop.
- `handleVmCancelProvision` không có provision đang chạy cho `runtimeId` → `{cancelled: false}`, không lỗi.
- Timeout thật sự abort được process con — dùng `spawnCommand` mock, xác nhận `kill` được gọi sau `DEFAULT_PROVISION_TIMEOUT_MS`.
- 2 provision đồng thời cho 2 `runtimeId` khác nhau không đụng registry của nhau.

## Verify

```bash
cd agent && npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "runRecipeCommand", direction: "upstream"})` — đã chạy
ở TASK-AG-EVM-001, chạy lại vì thêm call site thứ 2 (mode `create`,
dùng `onStdout`/`onStderr`/`signal` — nhánh trước đó chưa dùng tới).

## Blocking

[TASK-AG-EVM-003](./TASK-AG-EVM-003-dispatch-wire-vm-provision.md) phụ
thuộc task này.

---

## ✅ Kết quả thực tế (2026-09-08)

**Lệch quan trọng so với sketch (đã xác nhận qua đọc source thật, đúng
cảnh báo "Trước khi implement" của task):**

1. `sendFrame`/`WireState` — sketch import `sendFrame` từ `'./protocol'`.
   **Không có module `protocol.ts` nào trong `agent/src/relay/`.** Đọc
   `agent-git-handler.ts` xác nhận `sendFrame` là 1 helper **local, không
   export** (`function sendFrame(ws, wireState, payload)` ở cuối file,
   dùng `encodeDataFrame` từ package `orca-dev-agent-transport`), và
   `WireState` cũng là type từ `orca-dev-agent-transport`, không phải
   local. `agent-ephemeral-vm-handler.ts` mirror đúng — tự định nghĩa
   `sendFrame` local riêng (không export), import `encodeDataFrame`/
   `WireState` từ `orca-dev-agent-transport`.
2. `parseEphemeralVmRecipeResult` — sketch coi đây là hàm cần viết mới
   ("Contract đã có sẵn" nhưng không nói rõ đã có implementation). Xác
   nhận: **đã tồn tại thật**, export sẵn từ
   `agent/src/shared/ephemeral-vm-recipes.ts:147` — dùng thẳng, không viết
   lại. Trả về `EphemeralVmRecipeResultParseResult` (`{ok:true,result}` |
   `{ok:false,error}`), không phải raw `EphemeralVmRecipeResult`.
3. `handleVmProvision`'s 4th param — sketch dùng `id: string | number`;
   type thật của JSON-RPC id trong repo này là `string | number | null`
   (`JsonRpcRequest.id` ở `agent-rpc-dispatch.ts`) — dùng đúng type rộng
   hơn.

**Không lệch:** cấu trúc tổng thể (`provisionAbortRegistry` Map, timeout
15 phút mặc định, `AbortController` truyền qua `signal`, thứ tự
`stream.chunk*` → `stream.end`) đúng theo sketch.

**gitnexus impact:** chạy lại `impact()` trên `runRecipeCommand` (target_uid
thật, `repo:"orca"`) trước khi thêm call site thứ 2 — vẫn risk LOW, vẫn 4
caller trực tiếp cũ (`ephemeral-vm-recipe-runner.ts`), không caller nào bị
ảnh hưởng.

**Test:** `npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts` →
**28/28 pass** (bao gồm cả `handleVmExec` từ TASK-001). Cover đủ mọi test
case yêu cầu: thứ tự frame N×`stream.chunk` + 1×`stream.end`; parse cả 2
nhánh `orca-server`/`ssh` (dùng `encodePairingOffer` thật từ
`pairing.ts` để tạo `pairingCode` hợp lệ — literal string không qua được
`parsePairingCode`'s validate); exit non-zero không throw ra ngoài;
`handleVmCancelProvision` không có provision đang chạy → `{cancelled:
false}`; timeout thật sự abort signal (kiểm ở mức `handleVmProvision`
— `runRecipeCommand` bị mock toàn bộ ở test này nên assert trên
`AbortSignal.aborted`, không assert `child.kill()` thật — việc
`AbortSignal` → `kill()` thật đã được cover riêng ở
`ephemeral-vm-recipe-process.test.ts`); 2 provision đồng thời cho 2
`runtimeId` khác nhau không đụng registry của nhau.

**tsc --noEmit:** cùng 51 lỗi tiền tồn tại như TASK-001 (không liên quan),
không có lỗi nào trong `agent-ephemeral-vm-handler.ts`/`.test.ts`.

**Files đã sửa:**
- `agent/src/relay/agent-ephemeral-vm-handler.ts` (MODIFY — thêm
  `handleVmProvision`, `handleVmCancelProvision`, `validateVmProvisionParams`,
  `validateRuntimeIdParam`, `provisionAbortRegistry`, local `sendFrame`)
- `agent/src/relay/agent-ephemeral-vm-handler.test.ts` (MODIFY — thêm test
  cho provision, dùng `createWireState`/`decodeFrame` thật từ
  `orca-dev-agent-transport` để decode frame gửi qua `ws.send`, theo đúng
  convention `agent-wire.test.ts`'s round-trip encode/decode)
