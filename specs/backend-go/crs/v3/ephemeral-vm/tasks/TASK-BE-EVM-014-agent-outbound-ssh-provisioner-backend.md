# TASK-BE-EVM-014: Hướng A — phần backend-go (hidden-target table, Vault, RPC tới agent)

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §2-3 | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-012](./TASK-BE-EVM-012-ssh-mode-config-and-provisioner-interface.md) (interface)
**Status:** 🟡 PARTIAL — lõi (Vault resolve → RPC agent, audit table, test) chạy thật; 2 gap kiến trúc còn mở, xem "Kết quả thực tế"

---

## Mục tiêu

Implement `EphemeralVmSshProvisioner` cho `EPHEMERAL_VM_SSH_MODE=agent-outbound`
— resolve credential qua Vault, gửi xuống agent qua RPC, agent tự dial
(xem [SOL-AG-EVM-002/003](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-005-ssh-outbound-client.md)
cho phần agent tương ứng).

## Files cần sửa

1. `backend-go/services/infra-fleet-service/migrations/00XX_ephemeral_vm_ssh_targets.up.sql` (MỚI — bảng `infra.ephemeral_vm_ssh_targets`, khoá `runtime_id` FK `ephemeral_vm_runtimes.id`, cột `host`/`port`/`username`/`identity_file_vault_path`/`identity_agent_vault_path`)
2. `backend-go/common/secrets/vault.go` hoặc tương đương (MODIFY nếu cần — thêm method resolve theo path mới `secret/data/infra-fleet/ephemeral-vm-ssh-targets/<runtime_id>`, tách biệt path `ssh_targets` hiện có, theo đúng Quyết định 2 đã chốt)
3. `backend-go/services/infra-fleet-service/internal/usecase/agent_outbound_ssh_provisioner.go` (MỚI — implement `EphemeralVmSshProvisioner`: resolve Vault → gọi agent qua `DevServerAgentClient` với method mới)
4. `backend-go/services/infra-fleet-service/internal/usecase/ports.go` (MODIFY — thêm method mới vào `DevServerAgentClient`, ví dụ `DialHiddenSshTarget(ctx, devServer, runtimeID, target) (hiddenTargetID string, err error)`, và `ExecViaHiddenSshTarget(ctx, devServer, hiddenTargetID, command string) (...)` cho suspend/resume/destroy sau này)
5. `backend-go/services/infra-fleet-service/cmd/server/main.go` (MODIFY — wire khi config chọn `agent-outbound`)

## Nội dung (xem BE-SOL-EVM-004 §2-3, "Quyết định đã chốt" mục 1-2 cho chi tiết đã audit)

Credential resolve theo đúng quyết định đã chốt: `infra-fleet-service`
gọi Vault SSH secrets engine (path riêng, KHÔNG dùng chung `ssh_targets`)
lấy private key material, gửi **theo giá trị** làm tham số RPC (ví dụ
`vm.sshDial(runtimeID, target{host,port,username}, privateKeyPEM)`) qua
kênh agent↔Orca hiện có — mirror đúng cách `vm.exec`'s `command` param đã
truyền.

**Phía agent chưa tồn tại tại thời điểm task này chạy** — nếu
[TASK-AG-EVM-006](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-006-hidden-target-registry-and-ssh-dial-rpc.md)
chưa xong, method mới trên `DevServerAgentClient` sẽ trả lỗi thật
`ErrAgentMethodNotFound` khi test integration — chỉ cần unit test với
fake `DevServerAgentClient` ở task này, không chặn bởi agent chưa xong.

## Test cases cần cover

- `TestAgentOutboundSshProvisioner_ResolvesVaultThenCallsAgent`
- `TestAgentOutboundSshProvisioner_CredentialNeverPersisted` (chỉ truyền qua RPC 1 lần, không ghi Postgres)
- `TestVaultSshPath_SeparateFromUserRegisteredSshTargets` (xác nhận path Vault dùng đúng prefix riêng)

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... -run 'AgentOutboundSsh|EphemeralVm'
```

## gitnexus

`impact({target: "DevServerAgentClient", direction: "downstream"})` — interface Go trung tâm, xác nhận mọi implementer cần thêm method mới (đã audit nhiều lần ở các task trước, chạy lại).

## Blocking

[TASK-BE-EVM-015](./TASK-BE-EVM-015-git-gateway-hidden-target-routing.md) phụ thuộc task này (cần `hiddenTargetID` khái niệm tồn tại).

## Kết quả thực tế (2026-09-08)

**Bối cảnh phối hợp:** TASK-BE-EVM-012 đã land THẬT trong lúc task này chạy
(agent song song) — `EphemeralVmSshProvisioner`/`domain.EphemeralVmSshTarget`/
`config.EphemeralVmSshMode`/`EphemeralVmRelay.WithSshProvisioner` đã tồn tại
đúng như audit lúc bắt đầu. Dùng NGUYÊN chữ ký đã land (không dùng bản pin
trong prompt vì bản land dùng `domain.EphemeralVmSshTarget`, không phải
`EphemeralVmSshTarget` bare) — đúng chỉ dẫn "nếu file ports.go đã có
interface này, dùng nguyên". TASK-BE-EVM-013 (Hướng B) cũng đã tạo
`backendrelaysshprovisioner`/`ephemeralsshconn` package song song, nhưng
CHƯA wire vào `main.go` tại thời điểm task này chạy.

**Đã implement (real, tested):**
1. Migration `migrations/0015_ephemeral_vm_ssh_targets.{up,down}.sql` —
   bảng `infra.ephemeral_vm_ssh_targets` đúng cột đã ghi trong "Files cần
   sửa" (`runtime_id` FK `ephemeral_vm_runtimes.id`, unique index theo
   runtime_id, `host`/`port`/`username`/`identity_file_vault_path`/
   `identity_agent_vault_path`).
2. `domain.EphemeralVmSshTargetRecord` (`internal/domain/ephemeral_vm_ssh_target.go`)
   — record Postgres, chỉ giữ Vault PATH, không bao giờ giữ material thật.
3. `usecase/ports.go` — thêm 3 port mới: `EphemeralVmSshTargetRepository`
   (Upsert/Get), `EphemeralVmSshDevServerResolver` (xem gap #1 dưới),
   `EphemeralVmSshVaultResolver` (narrow, `*secrets.Client.KVRead` thoả mãn
   trực tiếp — KHÔNG cần sửa `common/secrets/vault.go`, vì `KVRead`/`KVWrite`
   đã đủ generic (mount+path bất kỳ) cho path mới
   `secret/data/infra-fleet/ephemeral-vm-ssh-targets/<runtime_id>` — không
   cần method Vault mới). Thêm `DialHiddenSshTarget` vào
   `DevServerAgentClient` interface.
4. `usecase/agent_outbound_ssh_provisioner.go` (MỚI) —
   `AgentOutboundSshProvisioner` implement `EphemeralVmSshProvisioner`:
   resolve Vault (path riêng, deterministic theo runtime_id — KHÔNG tái
   dùng path `ssh_targets`) → gọi `agent.DialHiddenSshTarget` → upsert audit
   row (chỉ path, không material) → trả `runtimeID` làm `connectionID` (xem
   gap #2).
5. `adapter/devserveragent/methods.go` — `Client.DialHiddenSshTarget` thật,
   dùng `Exec(ctx, devServer, "vm.sshDial", params)` (tái dùng generic
   RPC channel, KHÔNG tạo channel mới) — trả lỗi `ErrAgentMethodNotFound`
   thật khi agent chưa implement `vm.sshDial` (TASK-AG-EVM-006 chưa xong),
   đúng như task đã lường trước.
6. `adapter/postgres/ephemeral_vm_ssh_target_repository.go` (MỚI) —
   `EphemeralVmSshTargetStore` (Upsert/Get thật qua pgx).
7. `cmd/server/main.go` — wire `agent-outbound` mode: construct
   `AgentOutboundSshProvisioner` khi `cfg.EphemeralVmSshMode ==
   "agent-outbound"` VÀ Vault client khởi tạo thành công; nếu không, log
   warning và không set option (giữ hành vi cũ — `ssh` bị record là error).
8. Test (`agent_outbound_ssh_provisioner_test.go`, tất cả pass thật):
   `TestAgentOutboundSshProvisioner_ResolvesVaultThenCallsAgent`,
   `TestAgentOutboundSshProvisioner_CredentialNeverPersisted`,
   `TestVaultSshPath_SeparateFromUserRegisteredSshTargets`, + 4 test phụ
   (skip-vault-khi-không-cần, vault-fail, devServer-resolve-fail,
   agent-dial-fail).

**Verify thật đã chạy (2026-09-08):**
```
cd backend-go/services/infra-fleet-service
go build ./...                                          # OK
go vet ./...                                             # OK
gofmt -l <mọi file đã sửa/tạo>                            # rỗng — sạch
go test ./internal/usecase/... -run 'AgentOutboundSsh|EphemeralVm' -v   # 30/30 PASS
go test ./...                                             # PASS toàn bộ service (chạy lại
  # sau khi TASK-013 tự merge main.go xong — panic thoáng qua ở
  # backendrelaysshprovisioner lúc TASK-013 còn code dở không còn tái hiện).
```

**Cập nhật phối hợp main.go (sau khi TASK-013 cũng land):** TASK-013's
agent tự thêm nhánh `else` cho `cfg.EphemeralVmSshMode != "agent-outbound"`
ngay dưới nhánh `agent-outbound` của tôi, tái dùng đúng biến
`ephemeralVmRelayOpts` và lời gọi `NewEphemeralVmRelay(..., ephemeralVmRelayOpts...)`
tôi đã viết — merge sạch, không trùng khai báo, build/test lại xác nhận OK.

**2 gap kiến trúc còn mở (không đoán liều, để lại cho follow-up task):**

1. **`EphemeralVmSshDevServerResolver` chưa có implementation thật.**
   `EphemeralVmSshProvisioner.Provision(ctx, tenantID, runtimeID, target)`
   (chữ ký đã CHỐT, không được đổi — dùng chung với Hướng B) không mang
   `connectionID`/`devServer` — nhưng cần biết dial RPC gửi tới agent nào.
   Audit code thật xác nhận: `EphemeralVmRelay.Provision` có `devServer`
   trong scope (từ `resolveDevServerAndRepoPath`) nhưng KHÔNG truyền nó vào
   `applyProvisionResult`/`applySshProvisionResult` (code TASK-012 landed
   thật, không phải giả định). `domain.EphemeralVmRuntime` cũng không có
   field devServerID nào. `main.go` wire 1
   `unimplementedEphemeralVmSshDevServerResolver` fail-closed (lỗi rõ ràng,
   không đoán/misroute) — cùng kiểu fail-safe `sshProvisioner == nil` đã có
   sẵn trong `EphemeralVmRelay`. Fix thật cần 1 trong 2: (a) thêm field
   devServerID vào `domain.EphemeralVmRuntime`, set tại đúng chỗ
   `resolveDevServerAndRepoPath` resolve devServer trong `Provision`, hoặc
   (b) đổi chữ ký `EphemeralVmSshProvisioner.Provision` để nhận thêm
   devServer/connectionID — (b) ảnh hưởng cả Hướng B, ngoài thẩm quyền đơn
   phương của task này.
2. **`Provision`'s `connectionID` trả về = `runtimeID`, KHÔNG phải 1 row
   `infra.connections` thật.** `target domain.EphemeralVmSshTarget` không
   mang `ProjectRoot` (`buildEphemeralVmSshTarget` — code TASK-012 landed —
   drop hẳn field này khi convert từ `VmProvisionResult.SshTarget`), nên
   không đủ dữ liệu gọi `domain.NewConnection` (cần `RepoPath`). Theo
   BE-SOL-EVM-004 §4 quyết định 3 (đã chốt), `ResolveConnection` cho
   runtime `ssh`-type vẫn trỏ Dev Server hiện có (không phải 1 host mới) —
   nên gap này KHÔNG chặn TASK-BE-EVM-015's routing (`hiddenTargetID` là
   thuộc tính trực giao), nhưng `connectionID` trả về hiện là 1 giá trị quy
   ước (`runtimeID`), không resolve được qua `ResolveConnection` thật cho
   tới khi `ProjectRoot` được thêm vào `Provision`'s input (đổi chữ ký
   dùng chung Hướng A/B — cùng lý do ngoài thẩm quyền task này).

**RPC method đặt tên cho phía agent (để đối chiếu TASK-AG-EVM-006/007):**
`vm.sshDial` — params: `{runtimeId, target: {host, port, username,
privateKeyPem, identityAgentSocket, jumpHost, proxyCommand}}`, kỳ vọng trả
`{hiddenTargetId}` (agent không trả cũng không lỗi — code fallback dùng
`runtimeId` làm `hiddenTargetId` theo quy ước BE-SOL-EVM-004 §4).
