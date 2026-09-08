# TASK-AG-EVM-001: `agent-ephemeral-vm-handler.ts` — `handleVmExec`

**Solution:** [SOL-AG-EVM-001](../solutions/SOL-AG-EVM-001-vm-exec-handler.md) | **CR:** CR-EVM-001
**Depends on:** Không (song song [TASK-BE-EVM-001](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-001-agent-vm-exec-params.md))
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Tạo file mới `agent-ephemeral-vm-handler.ts` với `handleVmExec`, tái dùng
`runRecipeCommand` đã có — sửa lỗi runtime đang chạy sai hôm nay
(`backend-go` gọi `vm.exec`, agent không có ai trả lời).

## Files cần sửa

1. `agent/src/relay/agent-ephemeral-vm-handler.ts` (MỚI)
2. `agent/src/relay/agent-rpc-dispatch-misc.ts` (MODIFY — thêm `case 'vm.exec'`, theo vị trí `case 'cli.install'` dòng 176-186)
3. `agent/src/relay/agent-ephemeral-vm-handler.test.ts` (MỚI)

## Nội dung (xem SOL-AG-EVM-001 §2-3)

```ts
// agent-ephemeral-vm-handler.ts
import { runRecipeCommand } from '../shared/ephemeral-vm-recipe-process'
import type { EphemeralVmRecipeContext } from '../shared/ephemeral-vm-recipe-runner'

export type VmExecParams = {
  repoPath: string
  command: string
  phase: 'suspend' | 'resume' | 'destroy'
  recipeId: string
  runtimeId: string
}

export async function handleVmExec(params: VmExecParams) {
  const context: EphemeralVmRecipeContext = {
    recipeId: params.recipeId, instanceId: params.runtimeId, repoPath: params.repoPath
  }
  const result = await runRecipeCommand({ command: params.command, repoPath: params.repoPath, mode: params.phase, context })
  if (result.exitCode !== 0) {
    throw new Error(`vm.exec (${params.phase}) exited ${result.exitCode}: ${result.stderr.slice(-2000)}`)
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}
```

```ts
// agent-rpc-dispatch-misc.ts — thêm case
case 'vm.exec': {
  const { handleVmExec } = await import('./agent-ephemeral-vm-handler')
  response = await handleVmExec(validateVmExecParams(rpc.params))
  break
}
```

## Test cases cần cover

- `handleVmExec` gọi `runRecipeCommand` đúng `mode` map từ `phase`.
- `exitCode !== 0` → throw, message chứa `phase` và tail `stderr` (≤2000 ký tự).
- Params thiếu `repoPath`/`command`/`phase`/`recipeId`/`runtimeId` → lỗi validate trước khi gọi `runRecipeCommand`.
- Dispatch: `case 'vm.exec'` với params hợp lệ → gọi đúng `handleVmExec`, trả `response` đúng dispatch loop convention.

## Verify

```bash
cd agent && npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "runRecipeCommand", direction: "upstream"})` trước khi
thêm call site mới — xác nhận không phá test/caller hiện có
(`ephemeral-vm-recipe-runner.ts` là caller chính hôm nay, dùng cho
desktop-local exec).

## Blocking

[TASK-AG-EVM-002](./TASK-AG-EVM-002-vm-provision-streaming-handler.md)
mở rộng cùng file này — nên xong task này trước để tránh 2 PR cùng sửa 1
file mới song song.

---

## ✅ Kết quả thực tế (2026-09-08)

Implement đúng theo sketch (SOL-AG-EVM-001 §2-3), không lệch — chỉ thêm:

- `validateVmExecParams(params: unknown): VmExecParams` (export riêng,
  không có trong sketch's khối `handleVmExec` nhưng cần thiết để tách
  validate khỏi exec — gọi từ dispatch case trước `handleVmExec`, đúng
  test case "Params thiếu field → lỗi validate trước khi gọi
  runRecipeCommand"). Xác nhận qua đọc source: `agent-rpc-dispatch-misc.ts`
  không có sẵn `requiredString`-style helper nào — mỗi case tự validate
  hoặc pass params thẳng cho handler; validate function được đặt trong
  `agent-ephemeral-vm-handler.ts` chứ không phải dispatch file, để giữ
  validate cạnh domain logic (theo mẫu `validateGitArgs` trong
  `agent-git-handler.ts`).
- Dispatch case's shape KHÔNG theo sketch's `response = ...; break` —
  source thật của `dispatchMiscRpc` dùng convention
  `try { return (await handleXxx(...)) as JsonRpcResponse } catch { return
  makeError(...) }` cho từng case riêng (xem `case 'cli.install'`) — case
  `vm.exec` viết theo đúng convention thật này, không phải sketch's giả
  định.

**gitnexus impact:** `impact({target_uid:
"Function:agent/src/shared/ephemeral-vm-recipe-process.ts:runRecipeCommand",
direction:"upstream", repo:"orca"})` → risk LOW, 4 direct callers, tất cả
trong `ephemeral-vm-recipe-runner.ts` (`runEphemeralVmRecipeStart/Cleanup/
Suspend/Resume`) — khớp đúng dự đoán của task doc, không có caller nào
khác bị ảnh hưởng bởi call site mới.

**Test:** `npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts
src/relay/agent-rpc-dispatch-misc.test.ts` → **18/18 pass**.

**tsc --noEmit:** 51 lỗi tiền tồn tại trong các file KHÔNG liên quan
(`AgentConfig` thiếu `orcaHttpUrl`/`apiSecret`, `AgentBinarySpec` thiếu
`apiKeyEnvVar`, v.v. — thuộc về ~226 file đang sửa dở khác trong working
tree, xác nhận qua `git status` các file đó không nằm trong diff của task
này). Không có lỗi nào trong `agent-ephemeral-vm-handler.ts`,
`agent-ephemeral-vm-handler.test.ts`, `agent-rpc-dispatch-misc.ts`, hay
`agent-rpc-dispatch-misc.test.ts`.

**Files đã sửa/tạo:**
- `agent/src/relay/agent-ephemeral-vm-handler.ts` (MỚI)
- `agent/src/relay/agent-ephemeral-vm-handler.test.ts` (MỚI)
- `agent/src/relay/agent-rpc-dispatch-misc.ts` (MODIFY — thêm `case 'vm.exec'`)
- `agent/src/relay/agent-rpc-dispatch-misc.test.ts` (MODIFY — thêm `describe('dispatchMiscRpc — vm.exec')`)
