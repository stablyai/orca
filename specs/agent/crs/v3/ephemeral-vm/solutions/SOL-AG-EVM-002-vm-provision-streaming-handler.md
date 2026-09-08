# SOL-AG-EVM-002: `vm.provision` — streaming exec, tái dùng khuôn `git.execStream`

> **🔲 Designed — chưa implement.** Phần agent của
> [CR-EVM-003](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-003-provision-streaming-rpc.md)
> — mở rộng `agent-ephemeral-vm-handler.ts`
> ([SOL-AG-EVM-001](./SOL-AG-EVM-001-vm-exec-handler.md)) với mode `create`,
> streaming.

**CR:** [CR-EVM-003](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-003-provision-streaming-rpc.md)
**backend-go counterpart:** [BE-SOL-EVM-002](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-002-provision-streaming-channel.md)
**TDD tham chiếu:** [TDD-AG-07](../../../../tdd/v5/07-jsonrpc-dispatch.md) §7 (Streaming Protocol — `git.execStream`'s `stream.chunk`/`stream.end`, mẫu tái dùng trực tiếp)

---

## 1. Vì sao tái dùng `git.execStream`'s wire shape, không phải PTY

TDD-AG-07 §7 đã tài liệu hoá đúng mẫu cần, và mẫu này **có code thật**
đang chạy — `agent/src/relay/agent-git-handler.ts:238-289`:

```
{ jsonrpc: '2.0', id, result: { type: 'stream.chunk', line: string } }                     // stdout
{ jsonrpc: '2.0', id, result: { type: 'stream.chunk', line: string, source: 'stderr' } }    // stderr
{ jsonrpc: '2.0', id, result: { type: 'stream.end', exitCode: number } }                     // kết thúc
```

`vm.provision` bản chất giống `git.execStream` (chạy 1 shell command dài,
muốn xem output realtime) hơn là giống PTY (phiên tương tác 2 chiều) —
dùng đúng khuôn này, không cần cơ chế mới. Xác nhận thêm ở phía
`backend-go`: comment thật tại `ports.go:312-322` tự nhận
`git.execStream`/`agent.spawn` "ack immediately then push further data
via notify — same shape as StreamPty" — tức đây là 1 mẫu đã kiểm chứng ít
nhất 2 lần trong cùng hệ thống.

## 2. Handler: mở rộng `agent-ephemeral-vm-handler.ts` với `handleVmProvision`

```ts
// agent/src/relay/agent-ephemeral-vm-handler.ts (mở rộng)
import { runRecipeCommand } from '../shared/ephemeral-vm-recipe-process'
import { sendFrame } from './protocol'   // hoặc helper tương đương agent-git-handler.ts dùng

export type VmProvisionParams = {
  repoPath: string
  command: string        // recipe's `create` field
  recipeId: string
  runtimeId: string
}

export async function handleVmProvision(
  ws: WebSocket, wireState: WireState, id: string | number, params: VmProvisionParams
): Promise<void> {
  const controller = new AbortController()
  provisionAbortRegistry.set(params.runtimeId, controller)   // cho vm.cancelProvision, xem mục 4

  try {
    const result = await runRecipeCommand({
      command: params.command,
      repoPath: params.repoPath,
      mode: 'create',
      context: { recipeId: params.recipeId, instanceId: params.runtimeId, repoPath: params.repoPath },
      signal: controller.signal,
      onStdout: (chunk) => sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.chunk', line: chunk } }),
      onStderr: (chunk) => sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.chunk', line: chunk, source: 'stderr' } })
    })

    // Parse dòng JSON cuối cùng trên stdout — EphemeralVmRecipeResultSchema
    // (frontend/src/shared/ephemeral-vm-recipes.ts), contract đã có sẵn,
    // không đổi bởi solution này.
    const parsed = parseEphemeralVmRecipeResult(result.stdout)
    sendFrame(ws, wireState, {
      jsonrpc: '2.0', id,
      result: { type: 'stream.end', exitCode: result.exitCode, provisionResult: parsed }
    })
  } catch (error) {
    sendFrame(ws, wireState, { jsonrpc: '2.0', id, result: { type: 'stream.end', exitCode: -1, error: String(error) } })
  } finally {
    provisionAbortRegistry.delete(params.runtimeId)
  }
}
```

Không có 1 response frame đơn nào cho `vm.provision` — theo đúng
convention `case 'git.execStream'` (TDD-AG-07 dòng 154-157: `// No single
response frame`).

## 3. Giới hạn thời lượng — rủi ro đã ghi ở BE-SOL-EVM-002

`provision` có thể chạy nhiều phút (VM cloud thật). Không có timeout tự
động ở tầng `StreamChannelHandler` (theo thiết kế, xem BE-SOL-EVM-002).
Agent cần tự áp 1 giới hạn hợp lý (ví dụ 15 phút, cấu hình được qua
recipe hoặc `ORCA_VM_PROVISION_TIMEOUT_MS`) để không treo vô hạn 1 Dev
Server nếu `create` command của recipe bị treo — dùng
`controller.abort()` sau timeout, tái dùng đúng `AbortSignal` đã truyền
vào `runRecipeCommand`.

## 4. Wire vào dispatch — `vm.provision` + `vm.cancelProvision`

```ts
// agent-rpc-dispatch-misc.ts
case 'vm.provision': {
  const { handleVmProvision } = await import('./agent-ephemeral-vm-handler')
  await handleVmProvision(ws, wireState, rpc.id, validateVmProvisionParams(rpc.params))
  return   // không set `response` — không gửi frame response đơn, theo mục 2
}
case 'vm.cancelProvision': {
  const { handleVmCancelProvision } = await import('./agent-ephemeral-vm-handler')
  response = await handleVmCancelProvision(validateRuntimeIdParam(rpc.params))
  break
}
```

`handleVmCancelProvision({runtimeId})` lookup `provisionAbortRegistry`,
gọi `.abort()` nếu tồn tại — trả `{cancelled: boolean}` (request/response
bình thường, không streaming).

## 5. Test

Theo mẫu có thể tham khảo `agent-git-handler.ts`'s test cho
`git.execStream` (nếu tồn tại — xác nhận trước khi viết mới) cộng
`ephemeral-vm-recipe-process.test.ts`'s mock `spawnCommand`:

- `handleVmProvision` gửi đúng thứ tự frame: N × `stream.chunk` rồi 1 ×
  `stream.end`, cùng `id` với request gốc.
- `stream.end.provisionResult` parse đúng cả 2 nhánh
  (`{type:'orca-server',...}`/`{type:'ssh',...}`).
- `command` exit non-zero → `stream.end.exitCode` khớp, không throw ra
  ngoài dispatch loop (agent không crash vì 1 provision thất bại).
- `vm.cancelProvision` gọi khi không có provision nào đang chạy cho
  `runtimeId` đó → `{cancelled: false}`, không lỗi.
- Timeout (mục 3) thật sự abort được process con — dùng `spawnCommand`
  mock để xác nhận `kill` được gọi.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| `sendFrame`/`WireState` API thật | Thấp-Trung bình | Xác nhận chữ ký chính xác ở `agent-git-handler.ts`/`protocol.ts` trước khi implement — tên tham số ở đây là suy đoán theo pattern, không phải đọc trực tiếp |
| `provisionAbortRegistry` là in-memory, mất khi agent restart | Trung bình | Nếu agent restart giữa lúc provisioning, `backend-go` sẽ không nhận thêm frame nào (stream vỡ tự nhiên qua WS disconnect) — cần xác nhận `BE-SOL-EVM-002`'s `drainVmProvisionOutput` xử lý đúng trường hợp stream đóng đột ngột (coi là lỗi, không treo vô hạn) |
| Giới hạn thời lượng cứng (mục 3) có thể quá ngắn cho VM cloud thật | Thấp | Nên cấu hình được qua recipe, không hardcode — nhưng cần 1 giá trị mặc định an toàn ngay từ solution này |

## Không thuộc phạm vi solution này

- `vm.exec` (suspend/resume/destroy, one-shot) — xem
  [SOL-AG-EVM-001](./SOL-AG-EVM-001-vm-exec-handler.md).
- Xử lý nhánh `{type:'ssh',...}` (dial SSH thật) — xem
  [SOL-AG-EVM-003](./SOL-AG-EVM-003-outbound-ssh-client.md); handler này
  chỉ parse và trả kết quả đó nguyên vẹn, không tự dial.

## Liên quan

- `agent/src/relay/agent-git-handler.ts:238-289` (`git.execStream`, mẫu wire tái dùng)
- `specs/agent/tdd/v5/07-jsonrpc-dispatch.md` §7
- `agent/src/shared/ephemeral-vm-recipe-process.ts` (`runRecipeCommand`)
- `backend-go/services/infra-fleet-service/internal/usecase/ports.go:312-322` (`StreamScreencast`'s doc comment, xác nhận mẫu này đã kiểm chứng ở backend-go)
- [SOL-AG-EVM-001](./SOL-AG-EVM-001-vm-exec-handler.md), [BE-SOL-EVM-002](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-002-provision-streaming-channel.md)
