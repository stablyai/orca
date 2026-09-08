# TASK-BE-EVM-016: Gap 1+2 — Hướng A: bỏ Vault-resolve sai, forward `identityFile` path + thread `sourceDevServer`/`ProjectRoot`

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §6a, §6b | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-014](./TASK-BE-EVM-014-agent-outbound-ssh-provisioner-backend.md) (đã DONE/PARTIAL)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Sửa `AgentOutboundSshProvisioner` (Hướng A): bỏ bước Vault-resolve (dựa
trên giả định sai — xem §6a), forward path `identityFile` thô trong
params `vm.sshDial`; đổi chữ ký `EphemeralVmSshProvisioner.Provision` để
nhận `sourceDevServer`/`ProjectRoot`, dùng tạo `infra.connections` row
thật.

## Files cần sửa

1. `internal/usecase/ports.go` (MODIFY — đổi chữ ký `EphemeralVmSshProvisioner.Provision`, thêm `ProjectRoot` vào `domain.EphemeralVmSshTarget`)
2. `internal/usecase/agent_outbound_ssh_provisioner.go` (MODIFY — bỏ Vault-resolve, forward `identityFilePath` thô, tạo `infra.connections` row thật bằng `ProjectRoot`, trả `connectionID` thật)
3. `internal/usecase/ephemeral_vm_relay.go` (MODIFY — `Provision`'s xử lý kết quả ssh: truyền `devServer` (đã có từ `resolveDevServerAndRepoPath`) + `VmProvisionResult.ProjectRoot` vào lời gọi `sshProvisioner.Provision`)
4. `internal/adapter/devserveragent/methods.go` (MODIFY — `DialHiddenSshTarget`'s params đổi `privateKeyPem` → `identityFilePath` khi target dùng identityFile; giữ `identityAgentSocket` không đổi)

## Nội dung (xem §6a/§6b cho thiết kế đầy đủ)

```go
// ports.go
type EphemeralVmSshProvisioner interface {
  Provision(ctx context.Context, tenantID, runtimeID string, sourceDevServer domain.DevServer, target EphemeralVmSshTarget) (connectionID string, err error)
}
// domain.EphemeralVmSshTarget thêm:
type EphemeralVmSshTarget struct {
  // ... field hiện có ...
  ProjectRoot string
  IdentityFilePath string  // path thô, KHÔNG resolve — thay cho PrivateKeyPEM's vai trò cũ ở Hướng A
}
```

**Xoá hẳn** logic Vault KV v2 resolve trong `agent_outbound_ssh_provisioner.go`
(đã audit ở TASK-BE-EVM-014 — path Vault này chưa từng đúng, không có
gì ghi vào đó bao giờ). `DialHiddenSshTarget`'s params gửi
`identityFilePath` = `target.IdentityFilePath` nguyên vẹn.

`Provision`'s cuối hàm: `domain.NewConnection(tenantID, runtimeID /* devServerID */, target.ProjectRoot, ...)`,
đăng ký row thật (mirror pattern `EstablishConnection`/`CreateConnection`
hiện có — audit trước khi viết lại logic đăng ký).

## Test cases cần cover

- `TestAgentOutboundSshProvisioner_ForwardsIdentityFilePathRaw_NoVaultCall`
- `TestAgentOutboundSshProvisioner_CreatesRealConnectionRowWithProjectRoot`
- `TestEphemeralVmRelay_SshProvision_PassesSourceDevServerAndProjectRoot`

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... -run 'AgentOutboundSsh|EphemeralVm'
```

## gitnexus

`impact({target: "EphemeralVmSshProvisioner", direction: "downstream"})` — đổi chữ ký interface, xác nhận cả 2 implementation (Hướng A đây, Hướng B ở TASK-BE-EVM-017) đều cập nhật.

## Blocking

TASK-BE-EVM-017 (Hướng B) dùng chung interface đã đổi — làm sau hoặc phối hợp cùng lúc.

## Kết quả thực tế (2026-09-08)

**Quyết định phối hợp signature (theo gợi ý trong prompt):** đổi chữ ký
`EphemeralVmSshProvisioner.Provision` là breaking cho CẢ 2 implementation —
đã cập nhật CẢ Hướng A (đầy đủ, task này) VÀ Hướng B
(`backendrelaysshprovisioner.Provisioner.Provision` — chỉ thêm tham số
`sourceDevServer domain.DevServer`, CHƯA dùng nó, để giữ `go build ./...`
chạy được ở mọi bước; TASK-BE-EVM-017 sẽ dùng tham số này thật cho
`ReadCredentialFile`). Quyết định này giữ nguyên đúng như task doc đã gợi ý
— tránh 1 khoảng thời gian build gãy giữa 2 task.

**Đã implement (real, tested):**
1. `internal/domain/ephemeral_vm_ssh_target.go` — `EphemeralVmSshTarget`
   thêm `ProjectRoot string` + `IdentityFilePath string`; doc comment cập
   nhật xác nhận Gap 1 (identityFile luôn là path cục bộ, không phải Vault
   pointer) — `PrivateKeyPEM` giờ CHỈ được set bởi Hướng B (sau khi
   `ReadCredentialFile` resolve, TASK-BE-EVM-017), không còn set trực tiếp
   từ recipe string nữa.
2. `internal/usecase/ports.go` — `EphemeralVmSshProvisioner.Provision` đổi
   chữ ký: thêm `sourceDevServer domain.DevServer`. XOÁ hẳn 2 port không
   còn cần: `EphemeralVmSshDevServerResolver` (gap đóng bằng cách truyền
   thẳng `sourceDevServer`, không cần lookup port riêng nữa) và
   `EphemeralVmSshVaultResolver` (Vault-resolve bị xoá hoàn toàn khỏi
   Hướng A).
3. `internal/usecase/agent_outbound_ssh_provisioner.go` — viết lại hoàn
   toàn: XOÁ hẳn logic Vault KV v2 resolve (`ephemeralVmSshVaultMount`/
   `ephemeralVmSshVaultPath`/`p.vault.KVRead` — không còn field `vault`
   /`devServers` trên struct). `Provision` giờ: (a) forward
   `target.IdentityFilePath` nguyên vẹn qua `agent.DialHiddenSshTarget`
   (không resolve gì), (b) upsert audit row (repurpose 2 field
   `IdentityFileVaultPath`/`IdentityAgentVaultPath` — comment cập nhật rõ
   không còn là Vault path, chỉ là path đã dial, giữ nguyên tên cột/struct
   field để tránh đổi migration ngoài phạm vi task), (c) gọi
   `domain.NewConnection(uuid.NewString(), tenantID, sourceDevServer.ID,
   target.ProjectRoot, "")` rồi `conns.CreateConnection` — trả `saved.ID`
   thật (không còn quy ước `runtimeID`).
4. `internal/usecase/ephemeral_vm_relay.go` — `Provision`'s goroutine
   truyền `devServer` (đã có từ `resolveDevServerAndRepoPath`) xuống
   `applyProvisionResult` → `applySshProvisionResult` →
   `sshProvisioner.Provision(ctx, tenantID, runtimeID, devServer, target)`.
   `buildEphemeralVmSshTarget` đổi chữ ký thêm `projectRoot string`, map
   `sshTarget.IdentityFile` vào `IdentityFilePath` (KHÔNG còn map vào
   `PrivateKeyPEM` — đây chính là gap 1 cũ).
5. `internal/adapter/devserveragent/methods.go` —
   `DialHiddenSshTarget`'s params: `privateKeyPem` → `identityFilePath`
   (dùng `target.IdentityFilePath`); `identityAgentSocket` giữ nguyên
   không đổi, đúng như task yêu cầu.
6. `internal/adapter/backendrelaysshprovisioner/provisioner.go` — Hướng B:
   `Provision` thêm tham số `sourceDevServer domain.DevServer` (compile-only
   ở task này, logic thật ở TASK-BE-EVM-017).
7. `cmd/server/main.go` — wiring Hướng A đơn giản hoá: bỏ nhánh
   `vaultClient == nil` guard (không còn cần Vault), bỏ hẳn
   `unimplementedEphemeralVmSshDevServerResolver` (struct + import
   `infradomain` không còn dùng, xoá theo). `NewAgentOutboundSshProvisioner`
   giờ nhận `(agentClient, repo, ephemeralVmSshTargetStore)` — `repo` thoả
   `usecase.ConnectionRepository` (đã dùng sẵn cho Hướng B ngay bên dưới).
   Import `apperrors` cũng thành unused sau khi xoá struct trên, đã xoá.
8. Test — viết lại `agent_outbound_ssh_provisioner_test.go` hoàn toàn
   (Vault fakes xoá hết): `TestAgentOutboundSshProvisioner_ForwardsIdentityFilePathRaw_NoVaultCall`,
   `TestAgentOutboundSshProvisioner_CreatesRealConnectionRowWithProjectRoot`,
   `TestAgentOutboundSshProvisioner_AuditRowNeverCarriesPrivateKeyPEM`,
   `TestAgentOutboundSshProvisioner_AgentDialFails_ReturnsError`,
   `TestAgentOutboundSshProvisioner_CreateConnectionFails_ReturnsError`
   (dùng `fakeConnectionRepository` đã có sẵn trong package, từ
   `create_connection_test.go`). `ephemeral_vm_relay_test.go` — thêm
   `TestEphemeralVmRelay_SshProvision_PassesSourceDevServerAndProjectRoot`,
   cập nhật `fakeEphemeralVmSshProvisioner.Provision` chữ ký mới +
   `sourceDevServer` vào call record. `backendrelaysshprovisioner/provisioner_test.go`
   — 3 call site `.Provision(...)` thêm `domain.DevServer{...}` param
   (compile-only fix, không đổi assertion logic).

**Verify thật đã chạy (2026-09-08):**
```
cd backend-go/services/infra-fleet-service
go build ./...                                                 # OK
go vet ./...                                                    # OK
gofmt -l <mọi file đã sửa>                                       # rỗng — sạch
go test ./internal/usecase/... -run 'AgentOutboundSsh|EphemeralVm' -v   # 30/30 PASS (5 mới + các test EphemeralVmRelay hiện có)
go test ./...                                                   # PASS toàn bộ service (mọi package, bao gồm backendrelaysshprovisioner)
```

**Không có gap nào để lại** — cả 2 gap của TASK-BE-EVM-014 ("Kết quả thực
tế") đã đóng bởi task này.
