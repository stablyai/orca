# TASK-AG-EVM-009: Gap 1 — handler `vm.readCredentialFile` (cho Hướng B)

**Solution:** [SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md) "Sửa lại Gap 1 + Gap 4" | **CR:** CR-EVM-005
**Depends on:** [TASK-AG-EVM-008](./TASK-AG-EVM-008-local-identity-file-read.md)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Handler mới, hẹp, có chủ đích — backend-go (Hướng B) gọi TRƯỚC khi tự
dial off-machine, cần đọc `identityFile`'s content từ chính agent đã
chạy `Provision`.

## Files cần sửa

1. `agent/src/relay/agent-ephemeral-vm-handler.ts` (MODIFY — thêm `handleVmReadCredentialFile`)
2. `agent/src/relay/agent-rpc-dispatch-vm.ts` (MODIFY — thêm `case 'vm.readCredentialFile'`)
3. Test file tương ứng (MODIFY)

## Nội dung

```ts
export type VmReadCredentialFileParams = { path: string }

export async function handleVmReadCredentialFile(
  params: VmReadCredentialFileParams
): Promise<{ contentPEM: string }> {
  const contentPEM = await readFile(params.path, 'utf8')
  return { contentPEM }
}
```

```ts
// agent-rpc-dispatch-vm.ts
case 'vm.readCredentialFile': {
  try {
    const { handleVmReadCredentialFile } = await import('./agent-ephemeral-vm-handler')
    const path = requiredStringField((rpc.params ?? {}) as Record<string, unknown>, 'path')
    const result = await handleVmReadCredentialFile({ path })
    return { jsonrpc: '2.0', id: rpc.id, result }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeError(rpc.id, AgentErrorCode.ServerError, `vm.readCredentialFile failed: ${msg}`)
  }
}
```

**Bảo mật — quan trọng nhất của task này**: `contentPEM` KHÔNG BAO GIỜ
được log ở bất kỳ đâu trong dispatch loop (kể cả log lỗi/debug) — viết 1
test regression-guard riêng xác nhận không log content thật khi handler
throw hoặc khi response được gửi qua `makeError`. Response value tự nó
đi qua kênh agent↔Orca đã mã hoá (không phải lỗ hổng mới), nhưng log
file cục bộ của agent process không nên bao giờ chứa nó.

## Test cases cần cover

- `handleVmReadCredentialFile` đọc đúng nội dung file (mock `fs.readFile`)
- File không tồn tại → lỗi rõ, không crash
- `contentPEM` không xuất hiện trong bất kỳ log/error message nào (regression-guard bảo mật)
- Dispatch: `case 'vm.readCredentialFile'` với params hợp lệ → gọi đúng handler, response đúng shape

## Verify

```bash
cd agent && npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts src/relay/agent-rpc-dispatch-vm.test.ts
npx tsc --noEmit -p .
```

## gitnexus

Method mới, không có blast radius ngoài file đã liệt kê.

## Blocking

[TASK-BE-EVM-017](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-017-fix-credential-read-hourng-b.md) phụ thuộc task này (cần method thật tồn tại để test integration).

## Kết quả thực tế (2026-09-08)

Đối chiếu backend-go's TASK-BE-EVM-017 (đang TODO tại thời điểm viết,
chạy song song bởi agent khác) xác nhận đúng shape `{path}` →
`{contentPEM}` (`internal/adapter/devserveragent/methods.go`'s dự kiến
implement `ReadCredentialFile` gọi `Exec(ctx, devServer,
"vm.readCredentialFile", {path})`) — khớp 100% sketch của task này,
không cần điều chỉnh.

**`agent-ephemeral-vm-handler.ts` (MODIFY):** thêm
`VmReadCredentialFileParams`, `validateVmReadCredentialFileParams`
(export — mirror `validateVmExecParams`/`validateRuntimeIdParam`'s tiền
lệ, dùng `requiredStringField` cục bộ đã có sẵn), `handleVmReadCredentialFile`
đúng y sketch (`readFile(params.path, 'utf8')` → `{contentPEM}`).

**⚠️ Đổi vị trí dispatch case so với hiểu ban đầu**: task doc ghi
`agent-rpc-dispatch-vm.ts` — đã XÁC NHẬN đúng vị trí này (khác với
`vm.sshDial` ở TASK-006 phải tách sang file `agent-rpc-dispatch-hidden-target.ts`
mới vì `agent-rpc-dispatch-misc.ts` đã vượt budget). `agent-rpc-dispatch-vm.ts`
chỉ có 79 dòng trước khi sửa, còn nhiều dư địa — thêm `case
'vm.readCredentialFile'` trực tiếp vào đây, không cần tách thêm file
mới. Case gọi `validateVmReadCredentialFileParams`/
`handleVmReadCredentialFile` qua dynamic import, `makeError` khi throw —
đúng pattern các case khác trong cùng file.

**Bảo mật — `contentPEM` không log**: xác nhận `handleVmReadCredentialFile`
không cần scrub riêng — nhánh lỗi DUY NHẤT (`readFile` reject) xảy ra
TRƯỚC khi có content để đọc, nên không có cách nào content lọt vào
message lỗi qua đường này; nhánh thành công không throw. Viết rõ lý do
này trong doc comment thay vì thêm code scrub thừa không cần thiết.

**Test mới**: `agent-ephemeral-vm-handler.test.ts` — đọc đúng
content/lỗi rõ khi file không tồn tại + 2 test regression-guard (đọc
thất bại không echo secret; đường thành công không throw nên secret chỉ
rời handler qua return value có kiểu). `agent-rpc-dispatch-vm.test.ts` —
validate/handle/response đúng shape, lỗi validate/handler → ServerError
(không throw), + 1 regression-guard ở tầng dispatch xác nhận response
"wire" cuối cùng (`JSON.stringify`) không chứa secret.

**Verify thật đã chạy:**
```
npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts src/relay/agent-rpc-dispatch-vm.test.ts
  # 59/59 PASS
npx tsc --noEmit -p .
  # 0 lỗi trong agent-ephemeral-vm-handler.ts/agent-rpc-dispatch-vm.ts/2 test file
npx oxlint src/relay/agent-ephemeral-vm-handler.ts src/relay/agent-rpc-dispatch-vm.ts \
  src/relay/agent-ephemeral-vm-handler.test.ts src/relay/agent-rpc-dispatch-vm.test.ts -c ../.oxlintrc.json
  # 0 lỗi — agent-ephemeral-vm-handler.ts vẫn dưới ngân sách max-lines (300,
  # skipBlankLines/skipComments) dù đã lên 354 dòng thô; không cần tách file
```

Files sửa: `agent/src/relay/agent-ephemeral-vm-handler.ts`,
`agent/src/relay/agent-rpc-dispatch-vm.ts`,
`agent/src/relay/agent-ephemeral-vm-handler.test.ts`,
`agent/src/relay/agent-rpc-dispatch-vm.test.ts`.
