# SOL-AG-EVM-001: `agent-ephemeral-vm-handler.ts` — handler thật cho `vm.exec`

> **🔲 Designed — chưa implement.** Sửa 1 lỗi runtime đang chạy sai hôm
> nay: `backend-go` đã gọi `vm.exec` thật (3 call site), agent không có
> handler nào trả lời.

**CR:** [CR-EVM-001](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-001-agent-vm-exec-handler.md)
**backend-go counterpart:** [BE-SOL-EVM-001](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-001-agent-vm-exec-params.md)
**TDD tham chiếu:** [TDD-AG-07](../../../../tdd/v5/07-jsonrpc-dispatch.md) §1, §6 (JSON-RPC method router, cách thêm case mới)

---

## 1. Xác nhận nguyên liệu đã có — không viết lại logic exec

`agent/src/shared/ephemeral-vm-recipe-process.ts:23-` đã có
`runRecipeCommand`, hỗ trợ đúng những gì `vm.exec` cần:

```ts
export async function runRecipeCommand(args: {
  command: string
  repoPath: string
  context: EphemeralVmRecipeContext
  mode: 'create' | 'suspend' | 'resume' | 'destroy'
  stdin?: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: NodeJS.Signals | null }>
```

`vm.exec` (mode `suspend`/`resume`/`destroy`, one-shot — không dùng
`onStdout`/`onStderr`/`signal`, dành cho
[SOL-AG-EVM-002](./SOL-AG-EVM-002-vm-provision-streaming-handler.md)'s
`vm.provision`) chỉ cần gọi hàm này và đợi kết quả.

## 2. File mới: `agent/src/relay/agent-ephemeral-vm-handler.ts`

Theo đúng khuôn `agent-cli-handler.ts`/`agent-git-handler.ts` (1 file
module theo domain, export các hàm `handleXxx`, dispatch file import
lazy):

```ts
import { runRecipeCommand } from '../shared/ephemeral-vm-recipe-process'
import type { EphemeralVmRecipeContext } from '../shared/ephemeral-vm-recipe-runner'

export type VmExecParams = {
  repoPath: string
  command: string
  phase: 'suspend' | 'resume' | 'destroy'
  recipeId: string   // mới, xem BE-SOL-EVM-001
  runtimeId: string  // mới, xem BE-SOL-EVM-001
}

export async function handleVmExec(params: VmExecParams): Promise<{
  stdout: string
  stderr: string
  exitCode: number | null
}> {
  const context: EphemeralVmRecipeContext = {
    recipeId: params.recipeId,
    instanceId: params.runtimeId,
    repoPath: params.repoPath
    // projectId/workspaceId/workspaceName/repoUrl/branch (tất cả optional
    // theo EphemeralVmRecipeContext thật, ephemeral-vm-recipe-runner.ts:18-26)
    // không có sẵn trong vm.exec's params — để trống là hợp lệ, recipe
    // command không phụ thuộc chúng cho suspend/resume/destroy
  }
  const result = await runRecipeCommand({
    command: params.command,
    repoPath: params.repoPath,
    mode: params.phase,
    context
  })
  if (result.exitCode !== 0) {
    throw new Error(`vm.exec (${params.phase}) exited ${result.exitCode}: ${result.stderr.slice(-2000)}`)
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}
```

Ném lỗi (không trả `{success: false}`) — đúng convention `agent-cli-handler.ts`
đã dùng, để `backend-go`'s `callAgent` (`ephemeral_vm_relay.go:58-68`)
nhận đúng 1 lỗi thật để phân loại (không phải `ErrAgentMethodNotFound`,
vì method tồn tại — 1 lỗi exec thường, dịch thành `INFRA_AGENT_EXEC_FAILED`).

## 3. Wire vào `agent-rpc-dispatch-misc.ts`

Theo đúng vị trí/khuôn `case 'cli.install'`
(`agent-rpc-dispatch-misc.ts:176-186`):

```ts
case 'vm.exec': {
  const { handleVmExec } = await import('./agent-ephemeral-vm-handler')
  const params = validateVmExecParams(rpc.params)  // requiredString cho repoPath/command/phase/recipeId/runtimeId
  response = await handleVmExec(params)
  break
}
```

## 4. Test

Theo mẫu `agent/src/shared/ephemeral-vm-recipe-process.test.ts` (đã có,
cho `runRecipeCommand` bản thân) — thêm test riêng cho
`agent-ephemeral-vm-handler.test.ts`:

- `handleVmExec` gọi `runRecipeCommand` với đúng `mode` map từ `phase`.
- `exitCode !== 0` → throw, message chứa `phase` và tail `stderr`.
- Params thiếu field bắt buộc → lỗi validate trước khi gọi `runRecipeCommand`.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Đồng bộ với BE-SOL-EVM-001 | Thấp | 2 phía phải merge cùng lúc để tên field JSON khớp 1:1 |

## Không thuộc phạm vi solution này

- `vm.provision` (mode `create`, streaming) — xem
  [SOL-AG-EVM-002](./SOL-AG-EVM-002-vm-provision-streaming-handler.md);
  file `agent-ephemeral-vm-handler.ts` này sẽ được SOL-AG-EVM-002 mở rộng
  thêm, không tạo file riêng.

## Liên quan

- `agent/src/shared/ephemeral-vm-recipe-process.ts` (`runRecipeCommand`)
- `agent/src/relay/agent-cli-handler.ts`, `agent-rpc-dispatch-misc.ts:162-232` (khuôn mẫu)
- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go:56-68` (`callAgent`, nơi tiêu thụ kết quả/lỗi)
- [BE-SOL-EVM-001](../../../../backend-go/crs/v3/ephemeral-vm/solutions/BE-SOL-EVM-001-agent-vm-exec-params.md)
