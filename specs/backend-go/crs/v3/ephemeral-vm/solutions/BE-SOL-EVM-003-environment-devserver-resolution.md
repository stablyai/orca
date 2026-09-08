# BE-SOL-EVM-003: Resolve `environmentId` bare → dev server thật

> **🔲 Designed — chưa implement. Phụ thuộc cứng
> [BE-SOL-EVM-002](./BE-SOL-EVM-002-provision-streaming-channel.md).**
> Không thêm bảng mới nào — dùng đúng cột `environment_id` đã có sẵn
> trong `infra.ephemeral_vm_runtimes` (migration 0013) và primitive
> `ResolveConnectionRequest.dev_server_id` đã tồn tại.

**CR:** [CR-EVM-004](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-004-environment-devserver-resolution.md)
**Service:** `infra-fleet-service` (usecase mới trong `SpawnTerminalSession`'s resolution + `EphemeralVmRelay`) + `api-gateway` (channel `files.browseServerDir` mới)
**TDD tham chiếu:** [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md) §7's "connectionId resolution + relay dispatch flow" — solution này mở rộng đúng khung đó, không thay thế

---

## 1. Ghi `environment_id` khi `provision` pairing thành công

Trong `EphemeralVmRelay`'s xử lý kết quả `VmProvisionEvent{Type: "result",
Result.Type: "orca-server"}` (BE-SOL-EVM-002 mục 5), thêm 1 bước:

```go
// Sau khi agent's outbound dial (pairingCode) hoàn tất pairing thật:
uc.runtimes.SetEnvironmentID(ctx, tenantID, runtimeID, dialedDevServerID)
```

Dùng **chính id của `ephemeral_vm_runtimes` row** (hoặc `devServerId` agent
tự đặt khi dial, tuỳ bên nào ổn định hơn qua reconnect — cần xác nhận với
`agent-connection-direct.ts`'s cơ chế đặt `devServerId`, xem
[SOL-AG-EVM-002](../../../../agent/crs/v3/ephemeral-vm/solutions/SOL-AG-EVM-002-vm-provision-streaming-handler.md))
làm `dev_server_id`. Kết quả: `environment_id` **bằng luôn** `dev_server_id`
— đúng thiết kế đã sketch ở
[BACKLOG-002](../../../../../backlog/BACKLOG-002-environment-devserver-resolution.md),
không thêm bảng `environment_bindings` nào.

`domain.EphemeralVmRuntime.EnvironmentID` (field đã có sẵn,
`ephemeral_vm_runtime.go:20`) chỉ cần 1 method repository mới
`SetEnvironmentID` (update 1 cột, cùng khuôn `UpdateStatus` đã có).

## Quyết định đã chốt (TASK-BE-EVM-011)

**Audit thật đã xác nhận (2026-09-08), không suy đoán:**

1. `agent/src/shared/ephemeral-vm-recipe-process.ts`'s `buildRecipeEnv` chỉ
   set **env var thuần** cho recipe's `create` command process
   (`ORCA_VM_INSTANCE_ID: context.instanceId` = `runtimeId`,
   `ORCA_RECIPE_ID`, `ORCA_REPO_PATH`, …) — **không có** bất kỳ cơ chế
   template-substitute (`{{instanceId}}` hay tương tự) vào chuỗi
   `command` nào cả. `runRecipeCommand` truyền `command` cho `spawn(...,
   { shell: true })` y nguyên; chỉ `env` được mở rộng.
2. `EphemeralVmRelay.Provision` chạy trên **agent điều phối** (dev server
   agent đã kết nối sẵn tới backend-go) — nó chạy recipe's `create`
   command CỤC BỘ trên máy đó, KHÔNG PHẢI bên trong VM/container mới vừa
   tạo. `ORCA_VM_INSTANCE_ID=runtimeId` chỉ tới được recipe script này —
   việc chuyển tiếp giá trị đó vào bên trong VM mới (để trở thành
   `DEV_SERVER_ID` của 1 orca-agent process khác, chạy trong VM đó) là
   trách nhiệm của recipe author's script (`docker run -e
   DEV_SERVER_ID=$ORCA_VM_INSTANCE_ID …`, cloud-init, …) — Orca không có
   cơ chế nào tự động làm việc này.
3. **`environment_id` KHÔNG THỂ bằng `runtimeID`** (loại bỏ "phương án 3"
   — ghi `environment_id = runtimeID` ngay khi `Provision` nhận
   `VmProvisionResult.Type=="orca-server"`). Lý do, xác nhận qua đọc
   `resolve_direct_websocket_dev_server.go` + `postgres/repository.go`'s
   `Get`/`Register` + `token_endpoint.go`'s `handlePost`:
   - `dev_servers.id` (PK thật, dùng bởi `DevServerRepository.Get`,
     `RelayByDevServer`, `ResolveConnectionByDevServer` — tức chính giá
     trị `terminal.create`/`files.browseServerDir` cần để relay) là 1
     **UUID `uuid.NewString()` sinh MỚI, ngẫu nhiên**, tại thời điểm agent
     mới tự gọi `POST /api/agent-token` (`ResolveDirectWebSocketDevServer.Execute`)
     — một sự kiện async, xảy ra SAU và TÁCH RỜI khỏi `Provision`'s
     `stream.end`. Không ai (kể cả `Provision`'s usecase, biết `runtimeID`
     từ đầu) có thể đoán trước UUID này.
   - `runtimeID` chỉ có thể trở thành `dev_servers.Host` (nếu recipe
     author set `DEV_SERVER_ID=runtimeID` theo mục 2), KHÔNG PHẢI
     `dev_servers.id`. Ghi `environment_id = runtimeID` sẽ khiến
     `FindDevServerByEnvironmentID` (đã ship, TASK-BE-EVM-007) trả về 1
     `devServerID` không tồn tại trong bảng `dev_servers` → mọi
     `ResolveConnection`/`RelayByDevServer` sau đó **fail cứng**
     (`INFRA_DEV_SERVER_NOT_FOUND`) — vi phạm đúng hợp đồng
     "`environment_id` == `dev_server_id` thật" mà 007 đã dựa vào và ship.
4. **Quyết định: Hướng 1 (recipe set `DEV_SERVER_ID=runtimeID`) là nền
   tảng bắt buộc để có correlation key, nhưng chỗ GHI `environment_id`
   không phải trong `EphemeralVmRelay.Provision` như TASK-BE-EVM-006 sketch
   ban đầu** — mà là tại **`agentwsserver.TokenIssuer.handlePost`**
   (`token_endpoint.go`), ngay sau dòng `registrySlotKey = resolved.ID`
   (dòng ~207) — đúng nơi `dev_servers.id` thật lần đầu tồn tại:
   ```go
   // sau resolved, err := t.Resolver.Execute(...) thành công:
   if t.EphemeralVmRuntimes != nil {
     _, _ = t.EphemeralVmRuntimes.SetEnvironmentID(r.Context(), t.Cfg.DefaultTenantID, devServerID, resolved.ID)
     // best-effort, im lặng bỏ qua "not found" — devServerID hầu hết KHÔNG
     // phải 1 ephemeral_vm_runtimes.id (agent thường không phải VM ephemeral)
   }
   ```
   Đây KHÔNG phải "Hướng 2 polling" (không polling theo IP/host bất ổn) —
   `devServerID` (= `req.DevServerID`, external string agent tự khai khi
   xin token) CHÍNH LÀ correlation key xác định (deterministic), miễn
   recipe/VM's agent set `DEV_SERVER_ID=runtimeID` đúng hợp đồng mục 4.
   Bản chất là "Hướng 1 + sửa lại chỗ ghi cho đúng dòng đời sự kiện thật".
5. **Hợp đồng với recipe author: optional-with-fallback, KHÔNG bắt buộc.**
   Recipe cũ (không set `DEV_SERVER_ID`) hoặc recipe không tự chạy 1
   orca-agent process thứ 2 bên trong VM (VD: chỉ SSH-based, không dùng
   direct-websocket) — `environment_id` đơn giản ở lại NULL,
   `terminal.create`/`files.browseServerDir` tiếp tục trả
   `INFRA_TERMINAL_NO_COMPUTE_BOUND` y hệt hành vi hiện tại (§2 đã ghi
   "hành vi đúng, không đổi"). Không có gì backward-incompatible — đây là
   tính năng cộng thêm, chỉ recipe author chủ động opt-in mới có
   `terminal.create`/`files.browseServerDir` hoạt động trên ephemeral VM
   của họ. Lý do chọn optional thay vì bắt buộc: đây là quyết định kỹ
   thuật an toàn (không đổi hành vi mặc định), không cần review sản phẩm
   riêng — khác với các câu hỏi timeout/UX polling mà Hướng 2 gốc đặt ra
   (những câu hỏi đó bị loại bỏ hoàn toàn cùng với việc loại bỏ polling).
6. **`EphemeralVmRelay.Provision`'s "orca-server" xử lý (`applyProvisionResult`)
   GIỮ NGUYÊN** — vẫn chỉ set `status="provisioning"` như code hiện tại
   (comment sẵn có "a real pairing/environment_id still has to land" —
   đúng, nó land ở chỗ khác, không phải ở đây). TASK-BE-EVM-006's phạm vi
   sửa đổi so với sketch ban đầu: **KHÔNG sửa `ephemeral_vm_relay.go`**
   cho việc ghi `environment_id` (chỉ vẫn cần `SetEnvironmentID` trong
   `ports.go`/repository) — thay vào đó sửa `token_endpoint.go` +
   `NewTokenIssuer`'s constructor (thêm tham số
   `EphemeralVmRuntimes EphemeralVmRuntimeRepository`, nil-tolerant giống
   `Resolver`) + `main.go`'s wiring (truyền `ephemeralVmRuntimeStore`,
   đã tồn tại sẵn dòng 191, vào `NewTokenIssuer` ở dòng 311).

## 2. `terminal.create` — resolve `environmentId` trước `ResolveConnection`

`SpawnTerminalSession`'s resolution logic (đã có primitive alternate-key
resolution cho `dev_server_id`/`connection_id`) chỉ cần thêm 1 bước tra
cứu: nếu request mang `environmentId` bare, `SELECT dev_server_id_env AS
dev_server_id FROM infra.ephemeral_vm_runtimes WHERE environment_id =
$1 AND tenant_id = $2` trước khi gọi `ResolveConnection` — nếu không có
hàng nào khớp, tiếp tục trả `INFRA_TERMINAL_NO_COMPUTE_BOUND` như hôm
nay (hành vi đúng, không đổi).

**Không đổi `SpawnTerminalSessionRequest`'s proto shape** — vì
`environment_id == dev_server_id` (mục 1), request vẫn gửi 1 field, chỉ
khác nguồn tra cứu.

## 3. `files.browseServerDir` — channel mới, dùng chung bước resolve ở mục 2

```go
// channels_files.go (mới hoặc mở rộng nếu file này đã tồn tại cho mục đích khác)
r.Register("files.browseServerDir", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
  in, err := decodeArg[filesBrowseServerDirArgs](args, 0)  // {environmentId, path}
  devServerID, err := resolveEnvironmentToDevServer(ctx, id.TenantID, in.EnvironmentID)  // mục 2's helper, tái dùng
  resolved, err := infra.ResolveConnection(rpcCtx, &infrafleetv1.ResolveConnectionRequest{DevServerId: devServerID})
  // relay tới agent's devServer.browseDir-style RPC — cùng cách các path SSH/dev-server-bound khác đã dùng, xác nhận tên RPC thật trước khi implement (không đoán)
})
```

**Xác nhận cần làm trước khi implement**: tên RPC/agent-method thật mà
các path SSH/dev-server-bound khác dùng cho browse-dir (design doc gọi là
"`devServer.browseDir`-style" nhưng đây là mô tả, không phải tên xác
nhận từ code — audit `agent/src/relay/` cho tên method thật trước khi
viết relay call).

## 4. Kiểm thử theo đúng kế hoạch BACKLOG-002

- `spawn_terminal_session_test.go`: `environmentId` có binding
  resolvable (hàng `ephemeral_vm_runtimes.environment_id` tồn tại) rơi
  đúng vào nhánh devServerId thành công hiện có; `environmentId` không có
  binding vẫn trả `INFRA_TERMINAL_NO_COMPUTE_BOUND`.
- Test mới cho `files.browseServerDir`: relay đúng tới agent method thật
  (mục 3), và trả lỗi rõ ràng khi `environmentId` không resolve được (không
  rơi vào `notImplementedHandler` nữa).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng BE-SOL-EVM-002 | Cao nếu làm trước | Không có gì để resolve nếu `provision` chưa từng pairing thành công |
| Ổn định `dev_server_id` qua reconnect | Trung bình | Cần xác nhận agent's outbound dial giữ nguyên `devServerId` giữa các lần reconnect (không đổi mỗi lần dial lại) — nếu không, `environment_id` ghi 1 lần sẽ trỏ tới 1 `dev_server_id` đã chết sau reconnect; kiểm tra `agent-connection-direct.ts`'s cơ chế đặt id trước khi coi thiết kế mục 1 là đủ |
| Tên agent method cho browse-dir chưa xác nhận | Trung bình | Không dùng tên đoán — audit trước khi implement (mục 3) |

## Không thuộc phạm vi solution này

- Bản thân `provision` — xem [BE-SOL-EVM-002](./BE-SOL-EVM-002-provision-streaming-channel.md).
- `ssh`-type's resolution (`environment_id` NULL theo thiết kế cho nhánh này) — xem [BE-SOL-EVM-004](./BE-SOL-EVM-004-ssh-connection-type-backend.md).

## Liên quan

- `specs/backlog/BACKLOG-002-environment-devserver-resolution.md` (thiết kế gốc)
- `backend-go/services/infra-fleet-service/migrations/0013_ephemeral_vm_runtimes.up.sql:9`
- `backend-go/services/infra-fleet-service/internal/domain/ephemeral_vm_runtime.go:20` (`EnvironmentID` field đã có)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:654` (tiền lệ `dev_server_id` alternate-key)
- [BE-SOL-EVM-002](./BE-SOL-EVM-002-provision-streaming-channel.md) (phụ thuộc cứng)
