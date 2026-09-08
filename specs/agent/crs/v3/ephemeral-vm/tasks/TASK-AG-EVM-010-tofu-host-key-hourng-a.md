# TASK-AG-EVM-010: Gap 4 — TOFU host-key verification cho Hướng A

**Solution:** [SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md) "Sửa lại Gap 1 + Gap 4" | **CR:** CR-EVM-005
**Depends on:** [TASK-AG-EVM-008](./TASK-AG-EVM-008-local-identity-file-read.md)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

`dialOutboundSshTarget` hiện không verify host key (`ssh2` mặc định
không verify nếu không truyền `hostVerifier`) — thêm TOFU: dial đầu ghi
nhận fingerprint, trả về cho backend-go lưu; dial sau so khớp fingerprint
backend-go gửi lại.

## Files cần sửa

1. `agent/src/relay/ssh-outbound-client.ts` (MODIFY — thêm `hostVerifier` vào `ConnectConfig`, trả `hostKeyFingerprint` trong `OutboundSshSession`)
2. `agent/src/relay/agent-ephemeral-vm-handler.ts` (MODIFY — `handleVmSshDial` nhận `knownHostKeyFingerprint` optional trong params, trả `hostKeyFingerprint` trong response)
3. Test file tương ứng (MODIFY)

## Nội dung

```ts
// ssh-outbound-client.ts — dùng ssh2's hostVerifier (đồng bộ hoặc async tuỳ version, xác nhận API thật trước khi code)
function buildConnectConfig(
  target: SshDialTarget, credential: OutboundSshCredential, sock, knownFingerprint?: string
): ConnectConfig {
  return {
    // ... field hiện có ...
    hostVerifier: (keyBuffer: Buffer) => {
      const observed = computeSha256Fingerprint(keyBuffer)  // helper mới, dùng node:crypto
      if (!knownFingerprint) return true  // lần đầu — chấp nhận
      return observed === knownFingerprint
    }
  }
}
```

`dialOutboundSshTarget` trả thêm `hostKeyFingerprint: string` trong
`OutboundSshSession` (giá trị observed lần dial này) — `handleVmSshDial`
đưa vào response `{hiddenTargetId, hostKeyFingerprint}` để backend-go
lưu (agent không tự persist gì, đúng thiết kế đã chốt).

**Xác nhận trước khi code**: `ssh2`'s `ConnectConfig.hostVerifier` chữ
ký thật (sync trả `boolean` hay cần callback) — đọc `@types/ssh2`'s
`index.d.ts` (đã dùng ở TASK-AG-EVM-005), không đoán.

## Test cases cần cover

- Dial không có `knownFingerprint` → chấp nhận bất kỳ host key nào, trả đúng fingerprint observed
- Dial có `knownFingerprint` khớp → thành công
- Dial có `knownFingerprint` KHÔNG khớp → dial thất bại rõ ràng (không kết nối), lỗi message không lộ fingerprint đầy đủ nếu nhạy cảm (có thể chấp nhận lộ, không phải secret — xác nhận)
- `handleVmSshDial` trả đúng `hostKeyFingerprint` trong response

## Verify

```bash
cd agent && npx vitest run src/relay/ssh-outbound-client.test.ts src/relay/agent-ephemeral-vm-handler.test.ts
npx tsc --noEmit -p .
```

## gitnexus

`impact({target: "dialOutboundSshTarget", direction: "upstream"})` — đã audit nhiều lần, chạy lại vì đổi chữ ký `ConnectConfig`.

## Blocking

Đồng bộ với [TASK-BE-EVM-019](../../../../backend-go/crs/v3/ephemeral-vm/tasks/TASK-BE-EVM-019-tofu-host-key-hourng-b.md) — không phụ thuộc cứng lẫn nhau (2 hướng độc lập) nhưng cùng hoàn thành Gap 4.

## Kết quả thực tế (2026-09-08)

**Xác nhận chữ ký thật trước khi code (bắt buộc theo task doc)**: đọc
`node_modules/.pnpm/@types+ssh2@1.15.5/node_modules/@types/ssh2/index.d.ts`
(dòng 707-726) trực tiếp:
```ts
export type HostVerifier = (key: Buffer, verify: VerifyCallback) => void;
export type SyncHostVerifier = (key: Buffer) => boolean;
export type HostFingerprintVerifier = (fingerprint: string, verify: VerifyCallback) => boolean;
export type SyncHostFingerprintVerifier = (fingerprint: string) => boolean;
// ConnectConfig.hostVerifier?: HostVerifier | SyncHostVerifier | HostFingerprintVerifier | SyncHostFingerprintVerifier;
```
Dùng nhánh **`SyncHostVerifier`** — đồng bộ, nhận `key: Buffer` (khoá
host thô, chưa hash), trả `boolean` — khớp chính xác sketch của task doc
(`hostVerifier: (keyBuffer: Buffer) => boolean`), không cần callback
`verify`. (Có 1 nhánh khác — `hostHash` + `SyncHostFingerprintVerifier`
— để ssh2 tự hash và truyền string, nhưng task doc chỉ định rõ "dùng
`node:crypto`" nên giữ đúng hướng `SyncHostVerifier` + tự hash, không
đổi sang cơ chế `hostHash` có sẵn của ssh2.)

`gitnexus impact({target: "buildConnectConfig", direction: "upstream"})`
(repo `orca`, disambig `target_uid` do trùng tên 3 module khác) — xác
nhận **risk LOW**, 2 impacted (nội bộ module, đúng `dialOutboundSshTarget`).

**`ssh-outbound-client.ts` (MODIFY):**
- `SshDialTarget` thêm `knownHostKeyFingerprint?: string` — đặt TRONG
  `target` (không phải tham số riêng của `dialOutboundSshTarget`), nhất
  quán với cách `identityFilePath` (TASK-008) cũng là 1 field per-target
  — đây là 1 quyết định thiết kế của task này (task doc không nói rõ
  "trong params" nghĩa là top-level hay nested; chọn nested để khớp cách
  backend-go đã gửi mọi field khác của `vm.sshDial` trong `target`).
- `OutboundSshSession` thêm `hostKeyFingerprint: string` (luôn có giá
  trị khi dial thành công).
- Hàm mới `computeSha256Fingerprint(hostKey: Buffer): string` — dùng
  `node:crypto`'s `createHash('sha256')`, format `SHA256:<base64
  không padding>` (theo đúng quy ước OpenSSH/golang's
  `ssh.FingerprintSHA256` — không bắt buộc để so khớp liên ngôn ngữ ở
  đây vì Hướng A luôn tự tính VÀ tự so khớp trên cùng 1 agent, nhưng dễ
  đọc hơn nếu có ai từng nhìn thấy trong log/UI).
- `buildConnectConfig` thêm tham số `onHostKeyVerified` (callback) và
  field `hostVerifier` trong `ConnectConfig` trả về: tính fingerprint
  quan sát được, gọi callback (để `dialOutboundSshTarget` lưu lại), rồi
  so khớp `target.knownHostKeyFingerprint` nếu có (không có → chấp nhận,
  TOFU lần đầu).
- `dialOutboundSshTarget`: biến cục bộ `hostKeyFingerprint` được set qua
  callback, đưa vào `OutboundSshSession` trả về.

**`agent-ephemeral-vm-handler.ts` (MODIFY):** `validateVmSshDialParams`
đọc thêm `t.knownHostKeyFingerprint`; `handleVmSshDial` đổi kiểu trả về
thành `{hiddenTargetId, hostKeyFingerprint}` (lấy từ
`session.hostKeyFingerprint`) — đúng response shape SOL doc mô tả.

**Test mới** (`ssh-outbound-client.test.ts`): thêm helper
`completeHandshakeWithHostKey` — mô phỏng ĐÚNG hành vi ssh2 thật (gọi
`hostVerifier` đồng bộ trong lúc handshake, `false` → abort/emit
`'error'`) chạy trên chính hàm `hostVerifier` thật `buildConnectConfig`
tạo ra, không phải logic giả lập riêng. 3 test cases: lần đầu (không có
`knownHostKeyFingerprint`) chấp nhận bất kỳ + trả đúng fingerprint quan
sát; lần sau khớp → thành công; lần sau KHÔNG khớp → dial thất bại rõ
ràng (`accepted === false`, promise reject), message chứa fingerprint
KHÔNG bị scrub (fingerprint không phải secret, chỉ `privateKeyPEM`/nội
dung file mới bị scrub — xác nhận đúng như task doc gợi ý "có thể chấp
nhận lộ, không phải secret").
**Test mới** (`agent-ephemeral-vm-handler.test.ts`): parse
`target.knownHostKeyFingerprint` đúng (có/không có);
`handleVmSshDial` trả đúng `hostKeyFingerprint` từ session.

**🐛 Bug nhỏ tự bắt trong lúc viết test**: test case "mismatch" ban đầu
dùng `privateKeyPEM: 'k'` — trùng tình cờ với ký tự "k" trong chuỗi lỗi
"Host key verification failed", bị `scrubCredentialFromError` (đã có từ
TASK-005) thay thành "Host [REDACTED]ey verification failed", làm fail
assertion `toThrow('Host key verification failed')` vì lý do KHÔNG liên
quan gì đến TOFU logic đang test. Sửa bằng cách đổi sang giá trị
`privateKeyPEM` thực tế hơn (`'FAKE-KEY-PEM'`, giống các test khác
trong cùng file) — không phải bug trong code sản xuất, chỉ là test
fixture quá ngắn tình cờ va chạm.

**Verify thật đã chạy:**
```
npx vitest run src/relay/ssh-outbound-client.test.ts src/relay/agent-ephemeral-vm-handler.test.ts
  # 67/67 PASS (18 + 49 test trong 2 file, đã gộp cả TASK-008/009's test)
npx vitest run src/relay/
  # 109 test files, 1616 PASS, 4 skip (pre-existing, khớp số liệu TASK-006's baseline)
npx tsc --noEmit -p .
  # 0 lỗi trong ssh-outbound-client.ts/agent-ephemeral-vm-handler.ts/
  # agent-rpc-dispatch-vm.ts/agent-rpc-dispatch-hidden-target.ts/mọi test file đã sửa
  # (lỗi tsc còn lại trong repo — agent-session.ts/agent-spawner.ts/... — pre-existing,
  # đã "M" từ TRƯỚC phiên này trong git status, không đụng vào)
npx oxlint src/relay/ssh-outbound-client.ts src/relay/agent-ephemeral-vm-handler.ts \
  src/relay/agent-rpc-dispatch-vm.ts src/relay/agent-rpc-dispatch-hidden-target.ts \
  src/relay/ssh-outbound-client.test.ts src/relay/agent-ephemeral-vm-handler.test.ts \
  src/relay/agent-rpc-dispatch-vm.test.ts -c ../.oxlintrc.json
  # 0 lỗi — agent-ephemeral-vm-handler.ts (365 dòng thô), ssh-outbound-client.ts
  # (313 dòng thô) vẫn dưới ngân sách max-lines hiệu lực (skipBlankLines/
  # skipComments); không cần tách file thêm cho cả 3 task trong track này
```

Files sửa: `agent/src/relay/ssh-outbound-client.ts`,
`agent/src/relay/agent-ephemeral-vm-handler.ts`,
`agent/src/relay/ssh-outbound-client.test.ts`,
`agent/src/relay/agent-ephemeral-vm-handler.test.ts`.
