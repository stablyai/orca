# TASK-AG-EVM-007: fs/git provider cho hidden target

**Solution:** [SOL-AG-EVM-003](../solutions/SOL-AG-EVM-003-outbound-ssh-client.md) §2c | **CR:** CR-EVM-005
**Depends on:** [TASK-AG-EVM-006](./TASK-AG-EVM-006-hidden-target-registry-and-ssh-dial-rpc.md)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

2 module mới đọc fs/git **qua session SSH agent vừa dial ra** (không
phải kênh SSH inbound Orca đã mở) — mirror kiến trúc
`ssh-filesystem-stream-reader.ts`/`ssh-git-response-stream-reader.ts`,
KHÔNG tái dùng code (chiều dữ liệu khác hoàn toàn).

## Files cần sửa

1. `agent/src/relay/ssh-outbound-filesystem-provider.ts` (MỚI)
2. `agent/src/relay/ssh-outbound-git-provider.ts` (MỚI)
3. `agent/src/relay/agent-rpc-dispatch-misc.ts` (MODIFY — case mới cho method fs/git-via-hidden-target, khớp tên method TASK-BE-EVM-015 gọi tới)
4. Test files tương ứng

## Nội dung

Dùng `OutboundSshSession.client`'s SFTP subsystem (`ssh2`'s
`client.sftp(...)`) cho fs, và `client.exec('git ...')` cho git — lookup
`OutboundSshSession` từ `hiddenTargetRegistry` (TASK-AG-EVM-006) theo
`runtimeId`/`hiddenTargetId` nhận trong params.

**Xác nhận tên method RPC khớp với TASK-BE-EVM-015** trước khi implement
— method backend-go gọi (`fs.readViaHiddenTarget`/`git.statusViaHiddenTarget`
là tên sketch, chưa chắc là tên cuối) phải khớp chính xác `case` ở đây.

## Test cases cần cover

- `readDirViaHiddenTarget`/`readFileViaHiddenTarget` đọc đúng qua SFTP của session đã dial
- `gitStatusViaHiddenTarget`/tương đương chạy đúng qua `exec()` của session
- `hiddenTargetId` không tồn tại trong registry → lỗi rõ ràng, không crash
- Session đã đóng (agent restart giữa chừng) → lỗi rõ ràng, không treo

## Verify

```bash
cd agent && npx vitest run src/relay/ssh-outbound-filesystem-provider.test.ts src/relay/ssh-outbound-git-provider.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "hiddenTargetRegistry", direction: "upstream"})`.

## Blocking

Đây là điểm hoàn thành Hướng A phía agent — kết hợp với backend-go's
TASK-BE-EVM-014/015 để CR-EVM-005 hoạt động end-to-end cho cả 2 hướng.

## Kết quả thực tế (2026-09-08)

### ⚠️ Tên RPC method cuối cùng — ĐỐI CHIẾU VỚI backend-go's TASK-BE-EVM-015

Tại thời điểm hoàn thành task này, `backend-go`'s TASK-BE-EVM-014/015 vẫn
ở trạng thái 🔲 TODO (đã kiểm tra qua `git status`/grep — chưa có commit
nào chạm `HiddenTarget`/`ViaHiddenTarget` ở phía `backend-go`), nên
**không có tên đã chốt từ phía backend-go để đối chiếu ngay lúc này**.
Task này dùng đúng 3 tên ví dụ mà chính task doc đề xuất (khớp quy ước
đặt tên RPC method thật đã audit qua `agent-rpc-dispatch-fs.ts`/
`agent-rpc-dispatch-git-status.ts` — `fs.readDir`/`fs.readFile`/`git.status`
hiện có):

- **`fs.readDirViaHiddenTarget`** — params `{ hiddenTargetId, path }` →
  `{ entries: Array<{ name, type: 'file'|'directory'|'symlink'|'other' }> }`
- **`fs.readFileViaHiddenTarget`** — params `{ hiddenTargetId, path }` →
  `{ content: string /* base64 */, encoding: 'base64' }` (luôn base64,
  khác `fs.readFile` cục bộ dùng utf-8 khi không phải binary — quyết định
  đơn giản hoá, ghi rõ trong doc comment của provider)
- **`git.statusViaHiddenTarget`** — params `{ hiddenTargetId, repoPath }` →
  `{ branch: string|null, ahead: number, behind: number, files:
  Array<{ path, indexStatus, worktreeStatus }> }` (parse
  `git status --porcelain=v1 -b`)

**Backend-go's TASK-BE-EVM-015 PHẢI xác nhận khớp 3 tên này** (hoặc agent
side cần sửa lại nếu backend-go chốt tên khác) trước khi 2 phía nối được
end-to-end — task doc backend-go hiện cũng dùng đúng các tên sketch tương
tự (`fs.readViaHiddenTarget`/`git.statusViaHiddenTarget`, xem
TASK-BE-EVM-015 mục "Nội dung") nên rủi ro lệch tên ở mức thấp, nhưng
CHƯA xác nhận được 100% vì task đó chưa chạy.

### Files đã sửa/thêm

- `agent/src/relay/ssh-outbound-filesystem-provider.ts` (MỚI):
  `readDirViaHiddenTarget`/`readFileViaHiddenTarget` + validator tương ứng
  + `lookupHiddenTargetSession` (export, dùng chung với git provider) —
  dùng `session.client.sftp()`/`SFTPWrapper.readdir()`/`.readFile()`.
- `agent/src/relay/ssh-outbound-git-provider.ts` (MỚI):
  `gitStatusViaHiddenTarget` + validator — dùng `session.client.exec()`,
  parse `git status --porcelain=v1 -b`. `repoPath` được `shellQuote()`
  (single-quote, escape `'` kiểu POSIX `'\''`) trước khi nối vào command
  string — chặn shell injection qua RPC param (có test riêng xác nhận).
- ⚠️ **Đổi hướng so với task doc** (cùng lý do đã ghi ở TASK-AG-EVM-006's
  "Kết quả thực tế"): 3 `case` mới — `fs.readDirViaHiddenTarget`,
  `fs.readFileViaHiddenTarget`, `git.statusViaHiddenTarget` — nằm trong
  file dispatch MỚI `agent/src/relay/agent-rpc-dispatch-hidden-target.ts`
  (`dispatchHiddenTargetRpc`), KHÔNG phải `agent-rpc-dispatch-misc.ts` như
  task doc sketch — file đó đã vượt ngân sách oxlint `max-lines` (300)
  TRƯỚC khi CR-EVM-005 chạm vào (341 dòng "counted", thuộc phần dirty
  state ~226 file không liên quan). `agent-rpc-dispatch-hidden-target.ts`
  gộp chung cả `vm.sshDial` (TASK-AG-EVM-006) lẫn 3 case fs/git này —
  1 file, 1 domain rõ ràng ("hidden-target" RPC surface), đúng tinh thần
  tách-theo-domain codebase đã dùng cho git/fs/browser.
  `agent-rpc-dispatch.ts` (MODIFY): wire `dispatchHiddenTargetRpc` vào
  `route()` — 1 import + 1 block gọi, cạnh `dispatchMiscRpc`.
- 3 test file MỚI: `ssh-outbound-filesystem-provider.test.ts`,
  `ssh-outbound-git-provider.test.ts`, và
  `agent-rpc-dispatch-hidden-target.test.ts` (dispatch-level, cover cả 4
  case — `vm.sshDial` + 3 case fs/git — vì cùng 1 file dispatch).

Test cases yêu cầu trong task doc — tất cả đã cover và PASS thật:
- readDir/readFile qua SFTP của session đã dial: PASS (mock
  `session.client.sftp`).
- gitStatus qua `exec()`: PASS, kèm test parse porcelain output thật.
- `hiddenTargetId` không tồn tại trong registry → lỗi rõ ràng, không
  crash: PASS cho cả 2 provider (`lookupHiddenTargetSession` ném lỗi rõ
  message, không throw undefined/crash).
- Session đã đóng (agent restart giữa chừng) → lỗi rõ, không treo: PASS —
  mô phỏng bằng cách xoá entry khỏi `hiddenTargetRegistry` trước khi gọi
  (đúng hành vi thật: `handleVmSshDial` xoá/ghi đè entry khi session cũ bị
  đóng, không có entry "half-dead" nào tồn tại trong Map).

**Verify thật đã chạy (số liệu cuối cùng sau khi tách
`agent-rpc-dispatch-hidden-target.ts`):**
```
npx vitest run src/relay/ssh-outbound-filesystem-provider.test.ts src/relay/ssh-outbound-git-provider.test.ts
  # 14/14 PASS
npx vitest run src/relay/agent-rpc-dispatch-hidden-target.test.ts src/relay/agent-ephemeral-vm-handler.test.ts src/relay/ssh-outbound-client.test.ts src/relay/agent-rpc-dispatch-misc.test.ts
  # tất cả PASS (7 file liên quan CR-EVM-005 phía agent, gồm cả misc.test.ts
  # đã revert về nguyên trạng)
npx vitest run src/relay/                                   # 108 files, 1591 tests PASS, 4 skipped (pre-existing)
npx tsc --noEmit -p .                                        # 0 lỗi trong file mới/đã sửa
npx oxlint agent/src/relay/agent-rpc-dispatch-hidden-target.ts agent/src/relay/ssh-outbound-filesystem-provider.ts agent/src/relay/ssh-outbound-git-provider.ts agent/src/relay/agent-rpc-dispatch.ts [+ test files]
  # 0 lỗi (2 lỗi curly-brace tự phát hiện và tự sửa trong lúc làm task này)
```

**gitnexus:** `impact({target: "hiddenTargetRegistry", direction:
"upstream"})` yêu cầu trong task doc — MCP/CLI đều lỗi (cùng outage đã
ghi ở TASK-AG-EVM-005/006). Đã tự xác nhận thủ công qua đọc source: ngoài
`handleVmSshDial` (ghi) và 2 provider mới (đọc), không có consumer nào
khác trong repo tham chiếu `hiddenTargetRegistry` — rủi ro thấp, đúng kỳ
vọng (Map mới, phạm vi hẹp trong CR-EVM-005's Hướng A).
