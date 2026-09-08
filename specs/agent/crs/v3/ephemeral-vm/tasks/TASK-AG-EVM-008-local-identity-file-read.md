# TASK-AG-EVM-008: Gap 1 — Hướng A đọc `identityFile` cục bộ, bỏ `privateKeyPem` nhận qua RPC

**Solution:** [SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md) "Sửa lại Gap 1 + Gap 4" | **CR:** CR-EVM-005
**Depends on:** [TASK-AG-EVM-006](./TASK-AG-EVM-006-hidden-target-registry-and-ssh-dial-rpc.md) (đã DONE — mở rộng)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

`vm.sshDial`'s params đổi field `privateKeyPem` (đã resolve, sai tiền
đề) → `identityFilePath` (path thô) — `dialOutboundSshTarget` tự đọc
file cục bộ bằng `node:fs/promises`, KHÔNG nhận content qua RPC nữa.

## Files cần sửa

1. `agent/src/relay/ssh-outbound-client.ts` (MODIFY — `dialOutboundSshTarget`/`buildConnectConfig` đọc `identityFilePath` cục bộ nếu có, thay vì chỉ dùng `credential.privateKeyPEM` truyền vào)
2. `agent/src/relay/agent-ephemeral-vm-handler.ts` (MODIFY — `VmSshDialParams`/`validateVmSshDialParams`/`handleVmSshDial` đổi theo wire shape mới)
3. Test file tương ứng (MODIFY)

## Nội dung

```ts
// ssh-outbound-client.ts
import { readFile } from 'node:fs/promises'

export type SshDialTarget = {
  host: string; port: number; username: string
  identityAgent?: string
  identityFilePath?: string   // MỚI — path thô, agent tự đọc, KHÔNG nhận content qua RPC
  jumpHost?: string; proxyCommand?: string
}

async function resolvePrivateKey(target: SshDialTarget, credential: OutboundSshCredential): Promise<string | undefined> {
  if (credential.privateKeyPEM) return credential.privateKeyPEM  // tương thích ngược, không bắt buộc dùng
  if (target.identityFilePath) return readFile(target.identityFilePath, 'utf8')
  return undefined
}
// dùng resolvePrivateKey(...) thay credential.privateKeyPEM trực tiếp trong buildConnectConfig/dialViaJumpHost
```

```ts
// agent-ephemeral-vm-handler.ts — VmSshDialParams
export type VmSshDialParams = {
  runtimeId: string
  target: SshDialTarget   // giờ có identityFilePath, KHÔNG cần privateKeyPEM riêng nữa cho case này
}
```

`validateVmSshDialParams` đọc `target.identityFilePath` (string,
optional) thay vì `p.privateKeyPEM`/`target.privateKeyPem` là nguồn
credential chính — giữ `privateKeyPEM` field cho tương thích ngược
(Hướng nào khác có thể vẫn gửi content trực tiếp), nhưng
`identityFilePath` là đường chính cho case này.

**Bảo mật**: KHÔNG log path hay content khi đọc file lỗi (path có thể
tiết lộ cấu trúc thư mục nhạy cảm, content tuyệt đối không log — giữ
nguyên `scrubPrivateKeyFromError` đã có, mở rộng để cũng scrub nội dung
đọc được từ file nếu vô tình xuất hiện trong error message).

## Test cases cần cover

- `dialOutboundSshTarget` với `target.identityFilePath` set, không có `credential.privateKeyPEM` → đọc file cục bộ, dial thành công (mock `fs.readFile`)
- File không tồn tại → lỗi rõ ràng, không crash, không lộ path đầy đủ trong message nếu path chứa thông tin nhạy cảm (xem xét — có thể chấp nhận lộ path, chỉ chặn content)
- `credential.privateKeyPEM` vẫn ưu tiên nếu có (tương thích ngược) — không đọc file nếu đã có content qua RPC
- `validateVmSshDialParams` với wire shape mới (`target.identityFilePath`) parse đúng

## Verify

```bash
cd agent && npx vitest run src/relay/ssh-outbound-client.test.ts src/relay/agent-ephemeral-vm-handler.test.ts
npx tsc --noEmit -p .
```

## gitnexus

`impact({target: "dialOutboundSshTarget", direction: "upstream"})`.

## Blocking

Đồng bộ với [TASK-BE-EVM-016](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-016-fix-identity-file-passthrough-hourng-a.md) — 2 phía phải khớp tên field `identityFilePath` trong wire params.

## Kết quả thực tế (2026-09-08)

Đọc lại `ssh-outbound-client.ts`/`agent-ephemeral-vm-handler.ts` ngay
trước khi sửa (theo yêu cầu) — xác nhận state thật khớp đúng những gì
TASK-AG-EVM-005/006 để lại (bao gồm cả bugfix đối chiếu 2 phía đã ghi ở
TASK-AG-EVM-006's "Kết quả thực tế": `SshDialTarget` type hẹp, không
còn `EphemeralVmRecipeSshTarget`). Chạy `impact({target:
"dialOutboundSshTarget", direction: "upstream"})` (repo `orca`, disambig
qua `target_uid` do trùng tên với 1 fixture trong test) — xác nhận
**risk LOW, đúng 1 caller** (`handleVmSshDial`), khớp kỳ vọng task doc.

**`ssh-outbound-client.ts` (MODIFY):**
- `SshDialTarget` thêm field `identityFilePath?: string`.
- Hàm mới `resolvePrivateKey(target, credential)`: ưu tiên
  `credential.privateKeyPEM` (tương thích ngược — không đọc file nếu
  content đã có qua RPC); fallback `readFile(target.identityFilePath,
  'utf8')` (`node:fs/promises`); trả `undefined` nếu không có gì (case
  `identityAgent`-only).
- `dialOutboundSshTarget`: gọi `resolvePrivateKey` 1 lần ở đầu, dùng kết
  quả (`resolvedCredential`) xuyên suốt cả `dialViaJumpHost` lẫn
  `buildConnectConfig` — nghĩa là `scrubCredentialFromError` (đã có từ
  TASK-005) tự động scrub luôn cả nội dung đọc từ file (không cần code
  scrub riêng — cùng 1 code path, chỉ khác nguồn giá trị) — thoả đúng
  yêu cầu bảo mật "mở rộng để cũng scrub nội dung đọc được từ file".
- **Không scrub `target.identityFilePath` (path) khỏi error** — theo
  đúng ghi chú của task doc: chỉ content bị cấm lộ, path (ví dụ
  ENOENT's message) được chấp nhận lộ để còn debug được.

**`agent-ephemeral-vm-handler.ts` (MODIFY):** `validateVmSshDialParams`
đọc thêm `t.identityFilePath` (string, optional), đưa vào
`SshDialTarget`. Giữ nguyên toàn bộ logic `privateKeyPEM`/`privateKeyPem`
cũ (tương thích ngược, không phải nguồn chính nữa).

**⚠️ Vướng test timing, đã sửa**: `ssh-outbound-client.test.ts`'s helper
`resolveNextClientReady`/`rejectNextClientWithError` cũ dùng
`queueMicrotask` cố định để fire `'ready'`/`'error'` lên ssh2 client vừa
tạo — giả định ssh2 client được tạo ĐỒNG BỘ trước khi hàm await lần đầu.
Thêm `await resolvePrivateKey(...)` ở đầu `dialOutboundSshTarget` phá vỡ
giả định đó (client giờ tạo SAU 1 microtask nữa) → 10/15 test cũ + mới
timeout 5s (client chưa tồn tại khi `queueMicrotask` chạy). Sửa: đổi cả
2 helper sang polling qua `vi.waitFor` (cùng pattern đã dùng ở
jumpHost/proxyCommand tests có sẵn) — không phụ thuộc số lượng tick cụ
thể nữa.

**Test mới** (`ssh-outbound-client.test.ts`): đọc file cục bộ khi có
`identityFilePath` (mock `node:fs/promises`'s `readFile`); ưu tiên
`credential.privateKeyPEM`, không đọc file nếu đã có; lỗi rõ ràng khi
file không tồn tại (không crash, `createdClients` rỗng — xác nhận không
tạo ssh2 client nào nếu đọc file fail); không đọc file khi
`identityAgent`-only; regression-guard mới xác nhận content đọc từ file
cũng bị `[REDACTED]` giống `privateKeyPEM` qua RPC.
**Test mới** (`agent-ephemeral-vm-handler.test.ts`): parse
`target.identityFilePath` đúng, không có `privateKeyPem` nào cả.

**Verify thật đã chạy:**
```
npx vitest run src/relay/ssh-outbound-client.test.ts src/relay/agent-ephemeral-vm-handler.test.ts
  # 56/56 PASS
npx tsc --noEmit -p .
  # 0 lỗi trong ssh-outbound-client.ts/agent-ephemeral-vm-handler.ts/2 test file
  # (lỗi tsc còn lại trong repo là pre-existing, thuộc các file agent-session.ts/
  # agent-spawner.ts/... đã "M" từ TRƯỚC phiên này trong git status, không đụng)
npx oxlint src/relay/ssh-outbound-client.ts src/relay/agent-ephemeral-vm-handler.ts \
  src/relay/ssh-outbound-client.test.ts src/relay/agent-ephemeral-vm-handler.test.ts -c ../.oxlintrc.json
  # 0 lỗi (1 lỗi unicorn/prefer-at phát hiện + sửa trong lúc làm)
```

Files sửa: `agent/src/relay/ssh-outbound-client.ts`,
`agent/src/relay/agent-ephemeral-vm-handler.ts`,
`agent/src/relay/ssh-outbound-client.test.ts`,
`agent/src/relay/agent-ephemeral-vm-handler.test.ts`.
