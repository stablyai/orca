# TASK-BE-EVM-006: Ghi `environment_id` khi `provision` pairing thành công

**Solution:** [BE-SOL-EVM-003](../solutions/BE-SOL-EVM-003-environment-devserver-resolution.md) §1 | **CR:** CR-EVM-004
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-004](./TASK-BE-EVM-004-ephemeral-vm-relay-provision-usecase.md)
**Status:** ✅ DONE — 2026-09-08 (unblocked bởi TASK-BE-EVM-011, implement cùng lượt — xem "Kết quả thực tế")

---

**Kết quả thực tế:** [TASK-BE-EVM-011](./TASK-BE-EVM-011-provision-devserver-linkage-decision.md)
chốt quyết định (chi tiết đầy đủ ở
[BE-SOL-EVM-003](../solutions/BE-SOL-EVM-003-environment-devserver-resolution.md)'s
"Quyết định đã chốt") — tóm tắt: **`environment_id` = `dev_servers.id` thật**,
ghi tại `agentwsserver.TokenIssuer.handlePost` (`token_endpoint.go`) ngay
sau khi `ResolveDirectWebSocketDevServer.Execute` resolve/tạo `dev_servers`
row, KHÔNG PHẢI trong `EphemeralVmRelay.Provision`'s xử lý `orca-server`
result như sketch ban đầu bên dưới (event đó — `pairingCode`/mobile-pairing
— không bao giờ mang `dev_servers.id`; xác nhận qua audit thật, không suy
đoán). Correlation key: `devServerID` (agent's self-declared external id,
`req.DevServerID`) == `runtimeID`, chỉ đúng khi recipe/VM's agent process
được khởi động với `DEV_SERVER_ID=<runtimeID>` — 1 hợp đồng
**optional-with-fallback** với recipe author (không bắt buộc; không opt-in
thì `environment_id` ở lại NULL, hành vi `INFRA_TERMINAL_NO_COMPUTE_BOUND`
hiện tại không đổi).

**File đã sửa (khác "Files cần sửa" gốc bên dưới — xem lý do ở trên):**

1. `backend-go/services/infra-fleet-service/internal/usecase/list_ephemeral_vm_runtimes.go`
   (MODIFY) — thêm `SetEnvironmentID` vào `EphemeralVmRuntimeRepository`.
2. `backend-go/services/infra-fleet-service/internal/adapter/postgres/ephemeral_vm_runtime_repository.go`
   (MODIFY) — implement `SetEnvironmentID` (`UPDATE ... SET environment_id
   = $3 WHERE tenant_id = $1 AND id = $2`, đúng SQL sketch gốc).
3. `backend-go/services/infra-fleet-service/internal/adapter/agentwsserver/token_endpoint.go`
   (MODIFY, KHÔNG phải `ephemeral_vm_relay.go`) — thêm field
   `TokenIssuer.EphemeralVmRuntimes usecase.EphemeralVmRuntimeRepository`
   (nil-tolerant, cùng convention với `Resolver`), tham số mới trên
   `NewTokenIssuer`, và hàm `linkEphemeralVmRuntime` gọi
   `SetEnvironmentID(ctx, tenantID, devServerID, resolved.ID)` ngay sau
   `registrySlotKey = resolved.ID` trong `handlePost` — best-effort, im
   lặng bỏ qua `domain.ErrEphemeralVmRuntimeNotFound` (trường hợp phổ biến:
   agent thường không phải ephemeral VM).
4. `backend-go/services/infra-fleet-service/cmd/server/main.go` (MODIFY) —
   truyền `ephemeralVmRuntimeStore` (đã tồn tại sẵn dòng 191) vào
   `NewTokenIssuer` ở dòng 311. Không cần di chuyển gì (thứ tự đã đúng sẵn).
5. `backend-go/services/infra-fleet-service/internal/adapter/agentwsserver/token_endpoint_test.go`
   (MODIFY) — thêm `fakeEphemeralVmRuntimeRepo` +
   `TestTokenEndpoint_WithResolverAndRuntimes_LinksMatchingEphemeralVmRuntime`
   + `TestTokenEndpoint_WithResolverAndRuntimes_NoMatchingRuntimeIsSilent`;
   2 call site `NewTokenIssuer(...)` hiện có thêm tham số mới (`nil`).
6. `backend-go/services/infra-fleet-service/internal/usecase/list_ephemeral_vm_runtimes_test.go`
   (MODIFY) — `fakeEphemeralVmRuntimeRepository` (dùng chung với
   `ephemeral_vm_relay_test.go`) thêm `SetEnvironmentID` để giữ implement
   đúng interface mới.
7. `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session_test.go`
   (MODIFY) — `fakeEphemeralVmRuntimeRepositoryTenantSpy` thêm
   `SetEnvironmentID` (cùng lý do).

**`ephemeral_vm_relay.go` KHÔNG sửa** — `applyProvisionResult`'s xử lý
`orca-server` giữ nguyên (`UpdateProvisionResult(..., "provisioning",
"orca-server", "")`), đúng như quyết định.

**Test coverage thật:**
`TestTokenEndpoint_WithResolverAndRuntimes_LinksMatchingEphemeralVmRuntime`
(devServerID khớp 1 runtime → `SetEnvironmentID` gọi đúng
tenantID/runtimeID/`resolved.ID`), `TestTokenEndpoint_WithResolverAndRuntimes_NoMatchingRuntimeIsSilent`
(trường hợp phổ biến — không khớp — vẫn 200 OK, không lỗi). Không thêm
test postgres-level cho `SetEnvironmentID` (`TestSetEnvironmentID_UpdatesColumn`/
`ScopedByTenant` như sketch gốc) — xác nhận qua audit: package
`internal/adapter/postgres` của service này KHÔNG CÓ test file nào cho
`EphemeralVmRuntimeStore` từ trước (kể cả các method đã ship ở
001-008: `UpdateStatus`, `UpdateProvisionResult`, `FindDevServerByEnvironmentID`
đều chỉ có coverage ở usecase-level fake, không có integration test riêng)
— giữ đúng tiền lệ đã có, không tự thêm 1 integration test file mới
(`-tags=integration`, cần Docker/testcontainers) ngoài phạm vi task. SQL
đã được xác nhận đúng qua `go build ./...` (compile-check kiểu tham số) +
test end-to-end qua `TokenIssuer` ở trên (chứng minh đúng luồng gọi, dùng
fake repository).

**Verify thật đã chạy:**
```
cd backend-go/services/infra-fleet-service
go build ./...                                                                          # sạch
go vet ./...                                                                             # sạch
go test ./internal/usecase/... ./internal/adapter/postgres/... ./internal/adapter/agentwsserver/... -run EphemeralVm -v   # PASS
go test ./...                                                                            # PASS toàn service
go test -race ./internal/adapter/agentwsserver/... ./internal/usecase/...                # PASS, không race
gofmt -l .                                                                                # sạch
```
Không chạy `go build ./...` cho toàn bộ 19 module `go.work` — thay đổi chỉ
nằm trong package nội bộ (`internal/...`) của `infra-fleet-service`, các
service khác trong workspace không import package `internal` của service
khác (giới hạn Go), nên không có rủi ro rò rỉ build ra ngoài; đã xác nhận
riêng `infra-fleet-service`'s `go build ./...`/`go test ./...` sạch.

GitNexus MCP (`impact`/`detect_changes`) trả lỗi "Connection closed" suốt
session — dùng `codegraph_explore` thay thế (tiền lệ TASK-BE-EVM-007) để
xác nhận blast radius trước khi sửa `EphemeralVmRuntimeRepository`
(3 caller, package `usecase`) và `TokenIssuer`/`NewTokenIssuer` (2 caller
thật + test) — an toàn, risk thấp.

---

**Lý do BLOCKED trước đây (2026-09-08, đã unblock — giữ lại để tham khảo
lịch sử điều tra):** Task này yêu cầu xác nhận cơ chế
`agent-connection-direct.ts` đặt `devServerId` trước khi code (chính task
doc tự ghi). Đã đọc source thật và xác nhận được ĐÚNG 1 nửa câu hỏi,
nhưng nửa còn lại lộ ra 1 gap kiến trúc thật, không tự quyết được:

**Đã xác nhận (không còn mơ hồ):**
- `agent/src/relay/agent-connection-direct.ts:69` — `devServerId:
  config.devServerId`, lấy từ `AgentConfig.devServerId`
  (`agent-config.ts`'s `process.env.DEV_SERVER_ID || 'dev-local'`) — 1
  giá trị ổn định do config/env var quyết định khi process khởi động,
  KHÔNG phải random-gen mỗi lần reconnect. Rủi ro "không ổn định qua
  reconnect" mà BE-SOL-EVM-003 nêu → **đã loại bỏ**, miễn là process
  agent không bị restart với `DEV_SERVER_ID` khác.

**Chưa xác nhận được, và đây là gap thật (không phải tôi lười tra cứu)**:
- `EphemeralVmRelay.Provision` (TASK-BE-EVM-004, đã code) chỉ nhận được
  `VmProvisionResult{Type:"orca-server", PairingCode, ProjectRoot}` từ
  agent's `stream.end` — KHÔNG có `devServerId` nào trong đó.
  `pairingCode` (`agent/src/shared/pairing.ts`'s `PairingOffer`) là cơ
  chế PAIRING MOBILE APP (QR code, deviceToken, Curve25519 key) — hoàn
  toàn khác khái niệm "dev server" của `infra-fleet-service` (bảng
  `dev_servers`, `RegisterDevServer` RPC, `ResolveConnectionRequest.dev_server_id`).
  Không có bằng chứng nào trong code hiện tại cho thấy `pairingCode` có
  thể/được chuyển đổi thành 1 `dev_servers.id` — 2 hệ thống này đọc code
  ra không hề nối với nhau.
- Đường đăng ký dev server thật
  (`usecase.ResolveDirectWebSocketDevServer.Execute` →
  `FindByHostAndMode`/`Register`, gọi từ `token_endpoint.go` khi agent
  process tự xin token) là 1 luồng HOÀN TOÀN TÁCH BIỆT khỏi
  `Provision`'s luồng sự kiện — không có chỗ nào trong code nối 2 luồng
  này lại (ví dụ: recipe's `create` command không có bằng chứng template-substitute
  `runtimeId` thành `DEV_SERVER_ID` env var khi khởi động container/VM
  mới; `VmProvisionParams` gửi agent không mang theo 1 "devServerId dự
  định" nào để agent tự đặt).
- Do đó **không có cách nào Provision's usecase (chạy khi nhận
  `stream.end`) tự nó biết được `dev_servers.id` thật của VM vừa tạo** —
  giá trị đó (nếu có) chỉ tồn tại SAU KHI agent mới tự đăng ký qua
  `RegisterDevServer`/token endpoint, 1 sự kiện async, không đồng bộ với
  `Provision`'s event stream, và task-set 001-008 không có task nào wire
  2 luồng này lại với nhau.

**2 hướng khả dĩ, cả 2 đều cần quyết định kiến trúc, không tự chọn thay
được:**
1. Recipe's `create` command PHẢI set `DEV_SERVER_ID=<runtimeID>` (qua
   template substitution `{{instanceId}}` hoặc tương tự) khi khởi động
   VM/container mới — khi đó `environment_id = runtimeID` (đơn giản,
   dùng đúng ID đã có, khớp gợi ý "dùng chính id của
   ephemeral_vm_runtimes row" trong BE-SOL-EVM-003) — nhưng cần xác nhận
   template substitution này THẬT SỰ tồn tại trong
   `runRecipeCommand`/`EphemeralVmRecipeContext` (chưa đọc source đủ sâu
   để xác nhận field `instanceId` có được thay vào command string hay
   không) VÀ cần recipe author biết phải làm vậy (backward-incompat với
   recipe cũ nếu bắt buộc).
2. `Provision`'s usecase (hoặc `EphemeralVmRelay`) phải CHỦ ĐỘNG polling/subscribe
   `dev_servers` table sau khi nhận `stream.end` để tìm row mới khớp
   (theo host? theo 1 correlation id khác?) — thêm độ trễ/race, và cũng
   cần xác nhận `RegisterDevServer`'s `Host` field có thể dùng làm
   correlation key hay không (ephemeral VM's IP có ổn định/biết trước
   không?).

Không tự chọn 1 trong 2 vì cả 2 đều thay đổi hợp đồng giữa backend-go và
recipe author/agent — đúng loại quyết định
"quyết định kiến trúc cần người có thẩm quyền sản phẩm chốt" theo tiền lệ
TASK-AG-STORAGE-005/TASK-BE-EVM-009 đã dùng trong bộ task này.

**Đề xuất bước tiếp theo (không phải quyết định thay)**: tách 1 task
quyết định kiểu TASK-BE-EVM-009 (vd TASK-BE-EVM-006-DECISION hoặc gộp vào
BE-SOL-EVM-003's revision) để chốt hướng 1 hay 2 trước khi bất kỳ task
code nào cho TASK-BE-EVM-006/007/008 tiếp tục — cả 3 task này phụ thuộc
trực tiếp vào quyết định này (007/008 dùng `environment_id` do 006 ghi).

Không có file nào bị sửa cho task này — dừng đúng bước "trước khi
implement" như task doc's "Nội dung" section tự yêu cầu ("xác nhận trước
khi implement").

---

## Mục tiêu

Xác nhận `agent-connection-direct.ts`'s cơ chế đặt `devServerId` ổn định
qua reconnect (rủi ro đã ghi ở BE-SOL-EVM-003), rồi thêm
`SetEnvironmentID` repository method + gọi nó trong `Provision`'s xử lý
kết quả `orca-server` khi pairing thật hoàn tất.

## Files cần sửa

1. `backend-go/services/infra-fleet-service/internal/domain/ephemeral_vm_runtime.go` (KHÔNG đổi — `EnvironmentID` field đã có sẵn, dòng 20)
2. `backend-go/services/infra-fleet-service/internal/adapter/postgres/ephemeral_vm_runtime_repository.go` (MODIFY — thêm `SetEnvironmentID`)
3. `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (MODIFY — `Provision`'s xử lý kết quả `orca-server`, gọi `SetEnvironmentID` sau khi xác nhận pairing/dial thành công)
4. `backend-go/services/infra-fleet-service/internal/usecase/ports.go` (MODIFY — thêm `SetEnvironmentID` vào `EphemeralVmRuntimeRepository` interface)

## Nội dung (xem BE-SOL-EVM-003 §1)

```go
// ports.go — thêm vào EphemeralVmRuntimeRepository
SetEnvironmentID(ctx context.Context, tenantID, runtimeID, environmentID string) (domain.EphemeralVmRuntime, error)
```

```sql
-- ephemeral_vm_runtime_repository.go
UPDATE infra.ephemeral_vm_runtimes SET environment_id = $3, updated_at = now()
WHERE id = $2 AND tenant_id = $1
RETURNING id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''), workspace_id, COALESCE(last_error, ''), created_at, updated_at
```

`environment_id` = `devServerId` mà agent tự đặt khi dial (KHÔNG phải
`runtimeID`) — **xác nhận trước khi implement**: đọc trực tiếp
`agent-connection-direct.ts`'s `handshake` payload xem `devServerId` này
lấy từ đâu (agent tự gen 1 lần rồi giữ cố định, hay do provision command
truyền vào qua `ORCA_VM_*` env?) — nếu agent tự gen ngẫu nhiên mỗi lần
khởi động (không phải mỗi lần reconnect), cần 1 cơ chế khác để giữ ổn
định (ví dụ backend-go generate id NGAY khi `Provision` bắt đầu, truyền
xuống agent qua params `vm.provision`, agent dùng đúng id đó làm
`devServerId` khi dial pairing — đây có thể là thiết kế đúng hơn "chờ
agent tự đặt rồi đọc lại", cần quyết định trước khi code).

## Test cases cần cover

- `TestSetEnvironmentID_UpdatesColumn`
- `TestSetEnvironmentID_ScopedByTenant` (không update được row của tenant khác)
- `TestProvision_OrcaServerPairingSetsEnvironmentID`

## Verify

```bash
cd backend-go/services/infra-fleet-service && go build ./... && go test ./internal/usecase/... ./internal/adapter/postgres/... -run EphemeralVm
```

## gitnexus

`impact({target: "EphemeralVmRuntimeRepository", direction: "downstream"})`
— interface Go, xác nhận mọi implementer (thật + fake test double) đều
cần thêm method mới.

## Blocking

TASK-BE-EVM-007 phụ thuộc task này.
