# TASK-AG-EVM-006: Hidden-target registry + `vm.sshDial` RPC handler

**Solution:** [SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md) §2b, "Quyết định đã chốt" mục 1, 3 | **CR:** CR-EVM-005
**Depends on:** [TASK-AG-EVM-005](./TASK-AG-EVM-005-ssh-outbound-client.md)
**Status:** ✅ DONE (2026-09-08) — cộng 1 bugfix đối chiếu 2 phía (2026-09-08, xem cuối "Kết quả thực tế")

---

## Mục tiêu

Handler `vm.sshDial` nhận credential qua RPC param (KHÔNG tự gọi Vault —
quyết định đã chốt), gọi `dialOutboundSshTarget`, giữ session trong
registry in-memory `runtimeId → OutboundSshSession`.

## Files cần sửa

1. `agent/src/relay/agent-ephemeral-vm-handler.ts` (MODIFY — thêm `handleVmSshDial`, `hiddenTargetRegistry`)
2. `agent/src/relay/agent-rpc-dispatch-misc.ts` (MODIFY — thêm `case 'vm.sshDial'`)
3. Test file tương ứng (MODIFY)

## Nội dung

```ts
export type VmSshDialParams = {
  runtimeId: string
  target: EphemeralVmRecipeSshTarget
  privateKeyPEM?: string  // từ backend-go's Vault resolve — KHÔNG log, KHÔNG ghi đĩa
}

const hiddenTargetRegistry = new Map<string, OutboundSshSession>()

export async function handleVmSshDial(params: VmSshDialParams): Promise<{ hiddenTargetId: string }> {
  const session = await dialOutboundSshTarget(params.target, { privateKeyPEM: params.privateKeyPEM })
  hiddenTargetRegistry.set(params.runtimeId, session)
  return { hiddenTargetId: params.runtimeId }
}
```

**Retry**: theo quyết định đã chốt ở SOL-AG-EVM-003 mục 3 — agent KHÔNG
tự nhớ gì để khôi phục (dial luôn "cold"/idempotent); backend-go
(TASK-BE-EVM-014) chịu trách nhiệm phát lại `vm.sshDial` khi phát hiện
session mất qua lỗi relay — không code retry ở agent.

## Test cases cần cover

- `handleVmSshDial` dial thành công → registry có entry đúng `runtimeId`
- `privateKeyPEM` không bao giờ xuất hiện trong bất kỳ log/error message nào (regression-guard bảo mật, grep test output)
- Dial lại cho cùng `runtimeId` (giả lập reconnect sau agent restart) — không lỗi vì state cũ, ghi đè entry mới

## Verify

```bash
cd agent && npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "dialOutboundSshTarget", direction: "upstream"})`.

## Blocking

TASK-AG-EVM-007 phụ thuộc task này.

## Kết quả thực tế (2026-09-08)

Đọc lại `agent-ephemeral-vm-handler.ts`/`agent-rpc-dispatch-misc.ts` ngay
trước khi sửa (theo yêu cầu) — xác nhận state thật khớp 100% những gì
TASK-AG-EVM-001/002/003 để lại (vm.exec/vm.provision/vm.cancelProvision),
không có thay đổi ngoài dự kiến từ agent khác. Mở rộng cả 2 file, không
viết lại.

**RPC method tên cuối cùng: `vm.sshDial`** — đúng tên mặc định cả 2 phía
(agent + backend-go) đã thống nhất trong task doc, không đổi.

- `agent/src/relay/agent-ephemeral-vm-handler.ts` (MODIFY): thêm
  `VmSshDialParams`, `validateVmSshDialParams` (validate `runtimeId` +
  `target` qua `EphemeralVmRecipeSshTargetSchema.safeParse` — tái dùng
  schema thật, không tự viết lại rule), `hiddenTargetRegistry` (export,
  `Map<string, OutboundSshSession>`, in-memory), `handleVmSshDial`.
  - Re-dial cùng `runtimeId` (mô phỏng agent restart / backend-go retry):
    KHÔNG lỗi vì state cũ — ghi đè entry mới, đóng session cũ
    (`previous?.close()`) sau khi entry mới đã có trong map (không có
    khoảng trống lookup).
  - **Bảo mật — `privateKeyPEM` không bao giờ xuất hiện trong log/error
    message**: thêm `scrubPrivateKeyFromError` cục bộ trong file này (lớp
    phòng thủ thứ 2, độc lập với scrub đã có ở `ssh-outbound-client.ts`) —
    bọc mọi lỗi từ `dialOutboundSshTarget` trước khi throw ra khỏi
    `handleVmSshDial`, vì đây là boundary cuối trước khi message chạm
    `agent-rpc-dispatch-misc.ts`'s `makeError()`.
- ⚠️ **Đổi hướng so với task doc**: `case 'vm.sshDial'` KHÔNG nằm trong
  `agent-rpc-dispatch-misc.ts` như task doc sketch — file đó đã vượt
  ngân sách `max-lines` (300, `.oxlintrc.json`) từ TRƯỚC khi task này
  chạm vào (xác nhận qua `npx oxlint`: 341 dòng "counted" ngay cả sau khi
  revert hết thay đổi của task này — thuộc phần dirty state ~226 file
  không liên quan, KHÔNG được đụng vào theo yêu cầu). AGENTS.md cấm tuyệt
  đối thêm disable/bump `max-lines` inline. Giải pháp: tạo file dispatch
  MỚI `agent/src/relay/agent-rpc-dispatch-hidden-target.ts`
  (`dispatchHiddenTargetRpc`), đúng pattern codebase đã dùng sẵn cho
  chính vấn đề này (`agent-rpc-dispatch-git.ts`/`-fs.ts`/`-git-status.ts`/
  `-git-hooks.ts`/`-browser.ts` đều là tách ra từ 1 switch khổng lồ ban
  đầu, theo doc comment của chính chúng) — wire vào
  `agent-rpc-dispatch.ts`'s `route()` (thêm 1 import + 1 lệnh gọi, cạnh
  `dispatchMiscRpc`). File `agent-rpc-dispatch-misc.ts` được revert về
  đúng nguyên trạng trước khi task này chạm vào (không sửa gì thêm ở đó).
  `case 'vm.sshDial'` trong file mới giữ nguyên logic y hệt sketch ban
  đầu (dynamic `await import('./agent-ephemeral-vm-handler')`, `makeError`
  khi throw).
- Test: mở rộng `agent-ephemeral-vm-handler.test.ts` (mock
  `./ssh-outbound-client`'s `dialOutboundSshTarget`) + test file MỚI
  `agent-rpc-dispatch-hidden-target.test.ts` (mock `handleVmSshDial`/
  `validateVmSshDialParams`) — PASS thật, bao gồm 1 test regression-guard
  riêng bắt buộc theo yêu cầu: mock `dialOutboundSshTarget` reject với
  error CHỨA sẵn `privateKeyPEM` chưa scrub (mô phỏng lớp dưới bị rò),
  xác nhận `handleVmSshDial`'s thrown message KHÔNG chứa secret đó (đã bị
  thay `[REDACTED]`) + 1 test tương tự ở tầng dispatch xác nhận response
  cuối cùng ra "wire" cũng không chứa secret.

**Verify thật đã chạy (sau khi tách file dispatch, số liệu cuối cùng —
xem thêm TASK-AG-EVM-007's "Kết quả thực tế" vì 2 task chia sẻ cùng
`agent-rpc-dispatch-hidden-target.ts`):**
```
npx oxlint agent/src/relay/agent-rpc-dispatch-hidden-target.ts agent/src/relay/agent-rpc-dispatch.ts
  # 0 lỗi — agent-rpc-dispatch-misc.ts's pre-existing max-lines violation
  # (341 dòng, đã có TRƯỚC task này) không bị chạm vào, không tăng thêm
npx vitest run src/relay/                                   # 108 files, 1591 tests PASS, 4 skipped (pre-existing)
npx tsc --noEmit -p .                                        # 0 lỗi trong mọi file đã sửa/thêm
```

**gitnexus:** `impact({target: "dialOutboundSshTarget", direction:
"upstream"})` yêu cầu trong task doc — cả MCP lẫn CLI đều lỗi thật (cùng
outage đã ghi ở TASK-AG-EVM-005's "Kết quả thực tế": MCP "Connection
closed", CLI core dump). Fallback `codegraph explore "dispatchMiscRpc"`
xác nhận caller thật duy nhất là `agent-rpc-dispatch.ts`'s `route()` (3
lần gọi), khớp đúng vị trí thêm case mới, rủi ro thấp (thêm 1 case mới,
không sửa case cũ).

## 🔧 Bugfix đối chiếu 2 phía (2026-09-08, sau khi TASK-BE-EVM-014 hoàn thành song song)

Đối chiếu trực tiếp source thật của backend-go's `DialHiddenSshTarget`
(`internal/adapter/devserveragent/methods.go:224-`) phát hiện **lệch
contract thật** giữa 2 phía độc lập phát triển:

- backend-go gửi `params.target` **phẳng**: `{host, port, username,
  privateKeyPem, identityAgentSocket, jumpHost, proxyCommand}` — credential
  nằm **lồng trong** `target.privateKeyPem`, **không có** `label`.
- `validateVmSshDialParams` (bản gốc) parse `params.target` qua
  `EphemeralVmRecipeSshTargetSchema` — schema này **bắt buộc `label`** và
  đọc credential từ `params.privateKeyPEM` **cấp cao nhất** (không lồng).

**Hậu quả nếu không sửa**: mọi `vm.sshDial` thật từ backend-go bị agent
từ chối ngay ("target.label required"); kể cả sửa riêng phần label,
credential vẫn luôn `undefined` phía agent vì đọc sai vị trí field.

**Fix**: đổi `validateVmSshDialParams` sang parse trực tiếp field-by-field
đúng shape backend-go thật gửi (không dùng `EphemeralVmRecipeSshTargetSchema`
nữa — schema đó là của RECIPE, không phải của wire contract `vm.sshDial`),
đọc `privateKeyPem` từ trong `target` trước, fallback về `privateKeyPEM`
cấp cao nhất nếu có (tương thích ngược). Đồng thời hẹp type tham số của
`dialOutboundSshTarget` (`ssh-outbound-client.ts`) từ
`EphemeralVmRecipeSshTarget` (yêu cầu `label`) xuống 1 type mới
`SshDialTarget` chỉ gồm đúng field hàm thực sự dùng
(`host`/`port`/`username`/`identityAgent`/`jumpHost`/`proxyCommand`) — an
toàn ngược (mọi `EphemeralVmRecipeSshTarget` vẫn thoả mãn type hẹp hơn này
về mặt cấu trúc, không phá test/caller cũ).

**Verify thật đã chạy:**
```
npx vitest run src/relay/agent-ephemeral-vm-handler.test.ts src/relay/ssh-outbound-client.test.ts src/relay/agent-rpc-dispatch-hidden-target.test.ts
  # 59/59 PASS
npx vitest run src/relay/                          # 108 files, 1593 PASS, 4 skip (pre-existing)
npx tsc --noEmit -p .                               # 0 lỗi ở 2 file đã sửa
```

Files sửa thêm: `agent/src/relay/ssh-outbound-client.ts` (`SshDialTarget`
type mới, thay `EphemeralVmRecipeSshTarget` ở 3 chữ ký hàm),
`agent/src/relay/agent-ephemeral-vm-handler.ts` (`validateVmSshDialParams`
viết lại), `agent/src/relay/agent-ephemeral-vm-handler.test.ts` (test mới
`BACKEND_GO_WIRE_PARAMS` xác nhận đúng shape thật + regression-guard cho
shape cũ vẫn tương thích ngược).
