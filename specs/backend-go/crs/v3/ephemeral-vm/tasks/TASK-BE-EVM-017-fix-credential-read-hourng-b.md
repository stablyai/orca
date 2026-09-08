# TASK-BE-EVM-017: Gap 1+2 — Hướng B: gọi `vm.readCredentialFile` thay Vault, thread `sourceDevServer`/`ProjectRoot`

**Solution:** [BE-SOL-EVM-004](../solutions/BE-SOL-EVM-004-ssh-connection-type-backend.md) §6a, §6b | **CR:** CR-EVM-005
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-016](./TASK-BE-EVM-016-fix-identity-file-passthrough-hourng-a.md) (đổi chữ ký interface trước), [TASK-AG-EVM-009](../../../../agent/crs/v3/ephemeral-vm/tasks/TASK-AG-EVM-009-vm-read-credential-file-handler.md) (agent-side handler)
**Status:** ✅ DONE (2026-09-08)

---

## Mục tiêu

Sửa `BackendRelaySshProvisioner`/`ephemeralsshconn.Connector` (Hướng B):
thay bước "dùng thẳng `identityFile` string làm `PrivateKeyPEM`" (gap
đã ghi nhận ở TASK-BE-EVM-013) bằng 1 lời gọi RPC `vm.readCredentialFile`
tới `sourceDevServer` TRƯỚC khi dial, lấy bytes thật.

## Files cần sửa

1. `internal/usecase/ports.go` (MODIFY — thêm `ReadCredentialFile` vào `DevServerAgentClient` interface)
2. `internal/adapter/devserveragent/methods.go` (MODIFY — implement `ReadCredentialFile`, gọi `Exec(ctx, devServer, "vm.readCredentialFile", {path})`)
3. `internal/adapter/backendrelaysshprovisioner/provisioner.go` (MODIFY — nhận `sourceDevServer` (chữ ký mới từ TASK-BE-EVM-016), gọi `ReadCredentialFile` trước khi dial nếu `target.IdentityFilePath != ""`, dùng bytes trả về cho `ephemeralsshconn.Connector`)

## Nội dung

```go
// ports.go
type DevServerAgentClient interface {
  // ... method hiện có ...
  // ReadCredentialFile calls vm.readCredentialFile — reads path's content
  // on devServer's own filesystem (the SAME agent that ran the recipe's
  // create command, per Provision's design), for Hướng B's off-machine
  // dial. Response bytes are used once, in-memory only — see doc comment
  // at the wscompat/agent-side handler for the "never log" requirement.
  ReadCredentialFile(ctx context.Context, devServer domain.DevServer, path string) (contentPEM string, err error)
}
```

```go
// backendrelaysshprovisioner/provisioner.go — trước khi Connect()
var privateKeyPEM string
if target.IdentityFilePath != "" {
  privateKeyPEM, err = p.agent.ReadCredentialFile(ctx, sourceDevServer, target.IdentityFilePath)
  if err != nil { return "", fmt.Errorf("reading identity file from source dev server: %w", err) }
}
```

**Bảo mật**: `privateKeyPEM` biến cục bộ này KHÔNG được log/ghi Postgres
— chỉ dùng ngay trong `ephemeralsshconn.Connector.Connect()`, drop khỏi
bộ nhớ sau khi dial xong (đúng nguyên tắc đã áp dụng xuyên suốt CR-EVM-005).

## Test cases cần cover

- `TestBackendRelaySshProvisioner_ReadsCredentialFileFromSourceDevServer`
- `TestBackendRelaySshProvisioner_CredentialFileContentNeverLogged`
- `TestBackendRelaySshProvisioner_IdentityAgentSocket_SkipsCredentialFileRead` (nhánh identityAgent không cần đọc file)

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/adapter/backendrelaysshprovisioner/... -run '.*'
```

## gitnexus

`impact({target: "DevServerAgentClient", direction: "downstream"})` — interface trung tâm, xác nhận mọi implementer/fake test double cần thêm method mới.

## Blocking

Không task nào khác phụ thuộc.

## Kết quả thực tế (2026-09-08)

**Đã audit trước khi viết:** agent side (TASK-AG-EVM-009) đã LAND thật
trong lúc task này chạy — đọc trực tiếp
`agent/src/relay/agent-ephemeral-vm-handler.ts` xác nhận wire contract
thật: params `{path}`, response `{contentPEM}` (đúng như task doc sketch —
dùng nguyên, không đoán).

**Đã implement (real, tested):**
1. `internal/usecase/ports.go` — thêm `ReadCredentialFile(ctx, devServer,
   path) (contentPEM string, err error)` vào `DevServerAgentClient`.
2. `internal/adapter/devserveragent/methods.go` — implement
   `Client.ReadCredentialFile`: gọi `Exec(ctx, devServer,
   "vm.readCredentialFile", {path})`, giải mã `result["contentPEM"]`.
   Không log nội dung trả về.
3. `internal/adapter/backendrelaysshprovisioner/provisioner.go` —
   `Provision` (chữ ký đã có `sourceDevServer` từ TASK-BE-EVM-016): nếu
   `target.IdentityFilePath != ""`, gọi
   `p.agentClient.ReadCredentialFile(ctx, sourceDevServer,
   target.IdentityFilePath)` TRƯỚC khi build `ephemeralsshconn.Connector`,
   gán kết quả vào `target.PrivateKeyPEM` (biến `target` cục bộ, truyền by
   value — không sửa struct của caller). Nhánh `IdentityAgentSocket` không
   đổi (không gọi RPC này). `p.agentClient` là `*devserveragent.Client`
   thật (không phải port hẹp) — `ReadCredentialFile` mới ở bước 2 thoả mãn
   trực tiếp, không cần đổi field type.
4. `internal/usecase/scan_workspace_ports_test.go` — `fakeDevServerAgentClient`
   thêm `ReadCredentialFile` fake (pattern giống `dialHiddenSshTarget*`
   fields hiện có) — dùng bởi test usecase-layer khác nếu cần sau này
   (không có test usecase nào gọi trực tiếp ở task này, nhưng interface đủ
   để không phá `var _ DevServerAgentClient = (*fakeDevServerAgentClient)(nil)`
   ngầm định qua các usecase test khác dùng fake này).
5. `internal/adapter/backendrelaysshprovisioner/provisioner_test.go` —
   thêm `fakeCredentialTransport` (mirror `devserveragent`'s
   `pipeTransport` nội bộ, dựng lại bằng surface export
   `DecodeFrame`/`EncodeJSONRPCFrame`/`JSONRPCRequest`/`JSONRPCResponse` vì
   `pipeTransport` không export được) để attach 1 session sống cho
   `sourceDevServer`, cho `agentClient.ReadCredentialFile` round-trip thật
   qua JSON-RPC frame thật (không mock ở tầng Exec).

**Verify thật đã chạy (2026-09-08):**
```
cd backend-go/services/infra-fleet-service
go build ./...                                                            # OK
go vet ./...                                                               # OK
gofmt -l <mọi file đã sửa>                                                  # rỗng — sạch
go test ./internal/adapter/backendrelaysshprovisioner/... -run '.*' -v     # 6/6 PASS (3 test cũ + 3 test mới)
go test ./...                                                              # PASS toàn bộ service
```

**3 test case yêu cầu — cả 3 đều thật, không giả định:**
- `TestBackendRelaySshProvisioner_ReadsCredentialFileFromSourceDevServer` —
  round-trip JSON-RPC thật qua `fakeCredentialTransport`, xác nhận request
  gửi đúng method (`vm.readCredentialFile`) + `path` param, VÀ dial SSH
  thật vào fake SSH server chỉ chấp nhận đúng key mà `ReadCredentialFile`
  trả về (chứng minh bytes thật được dùng để auth, không chỉ fetch rồi bỏ).
- `TestBackendRelaySshProvisioner_CredentialFileContentNeverLogged` —
  static-scan `provisioner.go`'s source (mirror
  `ephemeralsshconn`'s `TestEphemeralSshConnector_CredentialNeverLoggedOrPersisted`
  convention y hệt): không import `log`/`log/slog`, không format
  `.PrivateKeyPEM`/`contentPEM` vào `Errorf`/`Sprintf`/`Print*`, không
  `%+v` cả struct `target`.
- `TestBackendRelaySshProvisioner_IdentityAgentSocket_SkipsCredentialFileRead`
  — `sourceDevServer` KHÔNG attach session nào cả; nếu code lỡ gọi
  `ReadCredentialFile` cho nhánh `identityAgent`, `Provision` sẽ lỗi ngay
  (không có live session) — test pass chứng minh nhánh này thật sự skip.

**Không có gap nào để lại** — cả 2 gap của TASK-BE-EVM-013 (Hướng B's
identityFile→PrivateKeyPEM chưa resolve, đã ghi trong
`domain.EphemeralVmSshTarget`'s doc comment cũ) đã đóng bởi task này.
