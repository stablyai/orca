# backend-go Tasks — Ephemeral VM

**Solutions:** [../solutions/](../solutions/README.md)

## Track 1 — `vm.exec` params (BE-SOL-EVM-001)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-EVM-001](./TASK-BE-EVM-001-agent-vm-exec-params.md) — thêm `recipeId`/`runtimeId` vào params `vm.exec` | Không | ✅ DONE |

## Track 2 — `provision` streaming (BE-SOL-EVM-002)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-EVM-002](./TASK-BE-EVM-002-provision-proto.md) — proto `StreamVmProvision` | Không | ✅ DONE |
| [TASK-BE-EVM-003](./TASK-BE-EVM-003-devserveragent-stream-vm-provision.md) — `DevServerAgentClient.StreamVmProvision` | 002 | ✅ DONE |
| [TASK-BE-EVM-004](./TASK-BE-EVM-004-ephemeral-vm-relay-provision-usecase.md) — `EphemeralVmRelay.Provision`/`CancelProvision` | 003 | ✅ DONE |
| [TASK-BE-EVM-005](./TASK-BE-EVM-005-wscompat-provision-channel.md) — wscompat channel `ephemeralVm.provision`/`cancelProvision` | 004 | ✅ DONE |

## Track 3 — Environment resolution (BE-SOL-EVM-003)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-EVM-006](./TASK-BE-EVM-006-set-environment-id.md) — ghi `environment_id` khi provision thành công | 004, 011 | ✅ DONE |
| [TASK-BE-EVM-007](./TASK-BE-EVM-007-terminal-create-environment-resolution.md) — `terminal.create` resolve `environmentId` | 006 (chỉ về dữ liệu — code đã implement độc lập, xem task's "Kết quả thực tế") | ✅ DONE |
| [TASK-BE-EVM-008](./TASK-BE-EVM-008-files-browse-server-dir-channel.md) — `files.browseServerDir` channel mới | 007 | ✅ DONE |

## Track 4 — `ssh`-type backend (BE-SOL-EVM-004) — 2 hướng song song, config-selected

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-EVM-009](./TASK-BE-EVM-009-ssh-design-decisions.md) — chốt 3 quyết định kiến trúc (không phải task code) | SOL-AG-EVM-003 (thiết kế) | ✅ DONE |
| [TASK-BE-EVM-012](./TASK-BE-EVM-012-ssh-mode-config-and-provisioner-interface.md) — config `EPHEMERAL_VM_SSH_MODE` + `EphemeralVmSshProvisioner` interface + gỡ guard | Không | ✅ DONE |
| [TASK-BE-EVM-013](./TASK-BE-EVM-013-backend-relay-deploy-provisioner.md) — **Hướng B**: `backendrelaysshprovisioner` (tái dùng `sshconn`/`sshrelay`) | 012 | ✅ DONE |
| [TASK-BE-EVM-014](./TASK-BE-EVM-014-agent-outbound-ssh-provisioner-backend.md) — **Hướng A**: hidden-target table, Vault, RPC tới agent | 012 | 🟡 PARTIAL — lõi chạy thật, test pass; 2 gap kiến trúc còn mở (xem task's "Kết quả thực tế") |
| [TASK-BE-EVM-015](./TASK-BE-EVM-015-git-gateway-hidden-target-routing.md) — **Hướng A**: `hiddenTargetID` routing trong `git-gateway-service` | 014 | 🟡 PARTIAL — cơ chế routing chạy thật + test pass; populate `HiddenTargetID` thật cần 2 thay đổi proto ngoài phạm vi (xem task's "Kết quả thực tế") |

## Track 6 — Fix 4 gap thật (BE-SOL-EVM-004 §6a-6d)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-EVM-016](./TASK-BE-EVM-016-fix-identity-file-passthrough-hourng-a.md) — Gap 1+2: Hướng A bỏ Vault-resolve sai, thread `sourceDevServer`/`ProjectRoot` | 014 | ✅ DONE |
| [TASK-BE-EVM-017](./TASK-BE-EVM-017-fix-credential-read-hourng-b.md) — Gap 1+2: Hướng B gọi `vm.readCredentialFile` | 016 | ✅ DONE |
| [TASK-BE-EVM-018](./TASK-BE-EVM-018-populate-hidden-target-id.md) — Gap 3: populate `hiddenTargetID` (2 proto) | 015 | ✅ DONE |
| [TASK-BE-EVM-019](./TASK-BE-EVM-019-tofu-host-key-hourng-b.md) — Gap 4: TOFU host-key (Hướng B) | 013 | ✅ DONE |

## Track 5 — Response shape audit (phát hiện từ FE-TASK-EVM-001)

| Task | Depends on | Status |
|---|---|---|
| [TASK-BE-EVM-010](./TASK-BE-EVM-010-runtime-response-shape-mismatch.md) — `toEphemeralVmRuntimeView` lệch field với frontend's `EphemeralVmRuntimeRecord` | Không | ✅ DONE |
| [TASK-BE-EVM-011](./TASK-BE-EVM-011-provision-devserver-linkage-decision.md) — quyết định kiến trúc nối `Provision`'s sự kiện với `dev_servers` row thật | 006 (BLOCKED) | ✅ DONE |

## Thứ tự thực thi

```
Track 1: 001                                          (độc lập, làm ngay)
Track 2: 002 → 003 → 004 → 005                        (tuyến tính)
Track 3:                004 → 011 → 006 → 007 → 008    (004 dùng chung với Track 2; 006 BLOCKED cho tới khi 011 chốt xong)
Track 4: 009 (đã chốt) → 012 → 013 (Hướng B) song song 014 → 015 (Hướng A)
Track 5: 010                                          (độc lập, không block track nào)
```

Track 4 giờ 2 hướng chạy song song sau 012: Hướng B (013) không phụ
thuộc Hướng A (014→015) và ngược lại — chọn qua config
`EPHEMERAL_VM_SSH_MODE` ở runtime, không phải "chọn 1 trong 2 lúc build".

Track 1 độc lập hoàn toàn, làm trước hoặc song song mọi track khác.
Track 2 là nền tảng — Track 3 phụ thuộc cứng vào TASK-BE-EVM-004 (Track
2's task cuối trước khi rẽ nhánh). Track 4 tách biệt hoàn toàn, chỉ bắt
đầu được sau khi phía agent (SOL-AG-EVM-003) có thiết kế đủ chi tiết —
hiện tại dừng ở mức sketch, chưa sinh ra task code.

## Nguyên tắc chung cho AI thực thi các task này

- **Luôn chạy `impact()`/`codegraph explore` trước khi sửa symbol** —
  mỗi task đã ghi symbol cần kiểm tra ở mục "gitnexus", nhưng đây là yêu
  cầu bắt buộc chung theo `CLAUDE.md`/`AGENTS.md`.
- **`buf generate` sau bất kỳ thay đổi `.proto` nào** (TASK-BE-EVM-002) —
  kiểm tra không phá `proto/gen/go` dùng chung với service khác, theo
  đúng sự cố đã ghi nhận ở `TASK-BE-STORAGE-006`.
- **Guard `connection_type == "ssh"` được gỡ ở TASK-BE-EVM-012**, thay
  bằng dispatch qua `EphemeralVmSshProvisioner` — mặc định config
  `EPHEMERAL_VM_SSH_MODE=backend-relay-deploy` (Hướng B, rủi ro bảo mật
  thấp hơn, tái dùng hạ tầng có sẵn); `agent-outbound` (Hướng A) chỉ hoạt
  động thật khi TASK-AG-EVM-005/006/007 (agent) cũng đã xong.
- **Test trước, không giả định pass** — mọi lệnh trong mục "Verify" phải
  thực sự chạy và thấy kết quả.
