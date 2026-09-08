# TASK-AG-EVM-005: `ssh-outbound-client.ts` — dial thật + jumpHost/proxyCommand

**Solution:** [SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md) §2a, "Quyết định đã chốt" mục 2 | **CR:** CR-EVM-005
**Depends on:** Không (độc lập kỹ thuật — chỉ cần thiết khi backend-go's `EPHEMERAL_VM_SSH_MODE=agent-outbound`)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Module mới, dial SSH outbound thật bằng `ssh2`, xử lý `jumpHost` (double-hop
qua `forwardOut()`) và `proxyCommand` (spawn `child_process`, bọc stdio
thành `Duplex`) — 2 field `ssh2` không hỗ trợ sẵn (đã xác nhận qua
`@types/ssh2@1.17.0`'s `index.d.ts`).

## Files cần sửa

1. `agent/src/relay/ssh-outbound-client.ts` (MỚI)
2. `agent/src/relay/ssh-outbound-client.test.ts` (MỚI)

## Nội dung (xem SOL-AG-EVM-003's "Quyết định đã chốt" mục 2 cho chi tiết kỹ thuật đầy đủ)

```ts
import { Client as Ssh2Client } from 'ssh2'
import type { EphemeralVmRecipeSshTarget } from '../shared/ephemeral-vm-recipes'

export type OutboundSshSession = { client: Ssh2Client; close(): void }

export async function dialOutboundSshTarget(
  target: EphemeralVmRecipeSshTarget,
  credential: { privateKeyPEM?: string }  // nhận từ RPC param (TASK-AG-EVM-006), KHÔNG tự fetch Vault
): Promise<OutboundSshSession> {
  const client = new Ssh2Client()
  const sock = target.jumpHost
    ? await dialViaJumpHost(target.jumpHost, target.host, target.port)
    : target.proxyCommand
      ? spawnProxyCommandDuplex(target.proxyCommand, target.host, target.port)
      : undefined
  await new Promise<void>((resolve, reject) => {
    client.on('ready', resolve).on('error', reject).connect({
      host: sock ? undefined : target.host,
      port: sock ? undefined : target.port,
      username: target.username,
      privateKey: credential.privateKeyPEM,
      agent: target.identityAgent,
      sock
    })
  })
  return { client, close: () => client.end() }
}
```

**`dialViaJumpHost`**: dial 1 `Ssh2Client` phụ tới jump host trước
(cùng credential hay credential riêng? — cần xác nhận: `jumpHost` field
là hostname trần, không mang credential riêng, theo `ssh-target-save-payload.test.ts` — mặc định dùng cùng `identitiesOnly`/agent forwarding config, xác nhận lại khi implement) → `forwardOut()` mở tunnel → trả `Duplex`.

**`spawnProxyCommandDuplex`**: spawn qua shell mặc định của host (KHÔNG
hardcode `/bin/sh` — Cross-Platform Support theo AGENTS.md), thay thế
token `%h`/`%p` trong `proxyCommand` bằng `target.host`/`target.port`
(OpenSSH `ProxyCommand` convention), bọc `stdin`/`stdout` thành 1
`Duplex` thủ công.

## Test cases cần cover

- `dialOutboundSshTarget` dial thành công với `privateKeyPEM` (mock `ssh2.Client`)
- `dialOutboundSshTarget` dial thành công với `identityAgent` (mock)
- `jumpHost` set → gọi đúng double-hop qua `forwardOut()`
- `proxyCommand` set → spawn đúng lệnh, thay token `%h`/`%p` đúng
- Không có credential nào bị log ra console/log file (regression-guard bảo mật)
- Cross-platform: `spawnProxyCommandDuplex` không hardcode shell path

## Verify

```bash
cd agent && npx vitest run src/relay/ssh-outbound-client.test.ts
npx tsc --noEmit
```

## gitnexus

Module hoàn toàn mới — không cần `impact()` cho symbol chưa tồn tại;
`impact({target: "EphemeralVmRecipeSshTarget", direction:"downstream"})`
để xác nhận không đổi type dùng chung.

## Blocking

TASK-AG-EVM-006 phụ thuộc task này.

## Kết quả thực tế (2026-09-08)

Cả 2 file MỚI đúng như kế hoạch — không đổi hướng so với sketch.

- `agent/src/relay/ssh-outbound-client.ts`: `dialOutboundSshTarget(target, credential)`
  export chính, cùng `OutboundSshSession`/`OutboundSshCredential` types.
  Khác 1 điểm so với sketch trong task doc: **thứ tự tạo `Ssh2Client` đảo
  lại** — client target thật chỉ được `new Ssh2Client()` SAU KHI hop
  jumpHost/proxyCommand đã sẵn sàng (không tạo trước rồi mới build sock),
  để không có 1 client "treo" chưa connect nếu hop thất bại; hành vi cuối
  (kết quả trả về) giống hệt sketch, chỉ khác thứ tự side-effect nội bộ.
  - `dialViaJumpHost`: dial `Ssh2Client` phụ tới `target.jumpHost` (port 22,
    cùng `username`/`privateKeyPEM`/`identityAgent` với target thật — đúng
    quyết định "không có credential riêng cho jumpHost") → `forwardOut()`
    → `Duplex`/`ClientChannel` dùng làm `sock`.
  - `spawnProxyCommandDuplex`: `child_process.spawn(resolvedCommand, {
    shell: true })` — để Node tự chọn shell theo host (ComSpec trên
    Windows, `$SHELL`/`sh` trên POSIX), KHÔNG hardcode path — đúng
    Cross-Platform Support (AGENTS.md). Thay `%h`/`%p` bằng
    `target.host`/`target.port` trước khi spawn.
  - `scrubCredentialFromError`: bọc mọi lỗi ném ra từ `dialOutboundSshTarget`
    — nếu `credential.privateKeyPEM` xuất hiện trong `.message`/`.stack`,
    thay bằng `[REDACTED]` trước khi throw. Defense-in-depth (ssh2 hiện
    không echo credential vào error, nhưng đảm bảo không có regression
    tương lai).
- `agent/src/relay/ssh-outbound-client.test.ts`: 10 test, tất cả PASS thật
  (không giả định) — dial thường (privateKeyPEM/identityAgent), close(),
  lỗi connect; jumpHost double-hop (thành công + forwardOut lỗi); proxyCommand
  (spawn đúng lệnh đã thay token, `shell: true` không hardcode path, ghi dữ
  liệu qua Duplex vào stdin con); regression-guard bảo mật (privateKeyPEM
  không xuất hiện trong error message khi bị lỗi connect).

**Verify thật đã chạy:**
```
npx vitest run src/relay/ssh-outbound-client.test.ts   # 10/10 PASS
npx tsc --noEmit -p .                                   # 0 lỗi trong file mới;
  # 131 dòng lỗi pre-existing trong agent-connection-relay.test.ts và các
  # file KHÁC (thuộc ~226 file đang sửa dở không liên quan, đã xác nhận
  # user hợp lệ — KHÔNG đụng vào, không phải lỗi do task này gây ra)
```

**gitnexus:** cả `mcp__gitnexus__impact` (MCP) lẫn CLI `gitnexus impact`
đều lỗi thật ở thời điểm chạy task này (MCP: "Connection closed"; CLI:
"dumped core" — instance GitNexus của repo này đang down, không phải lỗi
tham số/target). Dùng `codegraph explore` làm fallback (cũng bắt buộc theo
CLAUDE.md khi có `.codegraph/`) — xác nhận `EphemeralVmRecipeSshTarget`
(TS, phía agent/frontend) không có consumer nào khác ngoài
`ephemeral-vm-recipes.ts`'s schema + `agent-ephemeral-vm-handler.ts`; module
`ssh-outbound-client.ts` bản thân hoàn toàn mới nên không cần impact()
riêng (đúng ghi chú trong task doc).
