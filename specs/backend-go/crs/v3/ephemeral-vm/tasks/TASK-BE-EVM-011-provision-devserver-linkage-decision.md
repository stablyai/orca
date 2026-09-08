# TASK-BE-EVM-011: Quyết định kiến trúc — nối `Provision`'s sự kiện với `dev_servers` row thật

**Solution:** [BE-SOL-EVM-003](../solutions/BE-SOL-EVM-003-environment-devserver-resolution.md) §1 | **CR:** CR-EVM-004
**Service:** `infra-fleet-service`
**Depends on:** [TASK-BE-EVM-004](./TASK-BE-EVM-004-ephemeral-vm-relay-provision-usecase.md) (DONE)
**Status:** ✅ DONE — 2026-09-08 (quyết định chốt + TASK-BE-EVM-006 implement luôn, xem "Kết quả thực tế")

---

**Kết quả thực tế:** Quyết định chốt là **"Hướng 1, sửa lại đúng chỗ ghi"**
— không phải Hướng 1 nguyên bản, không phải Hướng 2 (polling theo IP/host),
và không phải "phương án 3" (ghi `environment_id = runtimeID` ngay khi
`Provision` nhận `orca-server`) mà prompt gợi ý — audit thật loại bỏ
phương án 3 vì `dev_servers.id` (giá trị PK thật `terminal.create`/
`files.browseServerDir` cần để relay, đã ship TASK-BE-EVM-007) là 1 UUID
`uuid.NewString()` sinh MỚI tại `ResolveDirectWebSocketDevServer.Execute`
(khi agent tự gọi `POST /api/agent-token`) — một sự kiện async, tách biệt
hoàn toàn khỏi `Provision`'s `stream.end`, không thể biết trước bởi bất kỳ
ai kể cả `Provision`'s usecase. Chi tiết đầy đủ + bằng chứng audit đã ghi
vào [BE-SOL-EVM-003](../solutions/BE-SOL-EVM-003-environment-devserver-resolution.md)'s
mục "Quyết định đã chốt (TASK-BE-EVM-011)" — tóm tắt:

1. `agent/src/shared/ephemeral-vm-recipe-process.ts`'s `buildRecipeEnv` đã
   xác nhận: chỉ set env var thuần (`ORCA_VM_INSTANCE_ID=runtimeId`, …) cho
   recipe's `create` command — KHÔNG có template substitution
   (`{{instanceId}}`) vào chuỗi `command`. `Provision` chạy recipe này trên
   agent điều phối (dev server agent có sẵn), không phải bên trong VM mới.
2. `environment_id` PHẢI bằng `dev_servers.id` thật (không phải
   `runtimeID`) — xác nhận qua đọc `resolve_direct_websocket_dev_server.go`
   (`domain.NewDevServer(uuid.NewString(), …)`), `postgres/repository.go`'s
   `Get` (`WHERE id = $2`), và `token_endpoint.go`'s `handlePost`
   (`registrySlotKey = resolved.ID`).
3. Correlation key đúng: `dev_servers.Host == runtimeID`, đạt được khi
   recipe author's script wiring `DEV_SERVER_ID=<runtimeID>` vào VM mới's
   orca-agent process — **optional-with-fallback** (không bắt buộc; recipe
   không opt-in thì `environment_id` ở lại NULL, hành vi hiện tại không
   đổi).
4. Chỗ GHI thật sự phải là `agentwsserver.TokenIssuer.handlePost`
   (`token_endpoint.go`), NGAY sau khi `resolved.ID` (dev_servers.id thật)
   xuất hiện lần đầu — KHÔNG PHẢI trong `EphemeralVmRelay.Provision`'s xử
   lý `orca-server` result như sketch ban đầu của TASK-BE-EVM-006 (event
   đó không bao giờ mang `dev_servers.id`).
5. TASK-BE-EVM-006 đã implement luôn theo quyết định này trong cùng lượt
   (đủ rõ ràng + an toàn, không cần thêm vòng review kiến trúc riêng) —
   xem [TASK-BE-EVM-006](./TASK-BE-EVM-006-set-environment-id.md)'s "Kết
   quả thực tế" cho danh sách file sửa + kết quả test thật.

GitNexus MCP (`impact`/`detect_changes`) trả "Connection closed" suốt
session này (giống tiền lệ TASK-BE-EVM-007) — dùng `codegraph_explore`
thay thế để xác nhận blast radius trước khi sửa (`EphemeralVmRuntimeRepository`:
3 caller trong package `usecase`; `TokenIssuer`/`NewTokenIssuer`: 2 caller
thật + bộ test riêng) — an toàn, không HIGH/CRITICAL risk.

## Bối cảnh — gap phát hiện khi thực thi TASK-BE-EVM-006

TASK-BE-EVM-006 (ghi `environment_id` khi provision pairing thành công)
BLOCKED khi thực thi (2026-09-08) — đọc kỹ nội dung BLOCKED đầy đủ ở
[TASK-BE-EVM-006](./TASK-BE-EVM-006-set-environment-id.md) trước khi làm
task này. Tóm tắt gap:

- `EphemeralVmRelay.Provision` (đã code, TASK-BE-EVM-004) chỉ nhận được
  `VmProvisionResult{Type:"orca-server", PairingCode, ProjectRoot}` từ
  agent — **không có `devServerId` nào trong đó**. `pairingCode` là cơ
  chế pairing mobile app (QR/deviceToken/Curve25519), không liên quan gì
  tới khái niệm `dev_servers` row của `infra-fleet-service`.
- Luồng đăng ký dev server thật (`ResolveDirectWebSocketDevServer` →
  `FindByHostAndMode`/`Register`, gọi từ `token_endpoint.go` khi agent tự
  xin token) là **hoàn toàn tách biệt** khỏi `Provision`'s event flow —
  không có code nào nối 2 luồng lại.
- Kết quả: không có cách nào `Provision`'s usecase (chạy khi nhận
  `stream.end`) tự biết được `dev_servers.id` thật của VM vừa tạo.

## Câu hỏi cần chốt

**Hướng 1** — Recipe's `create` command PHẢI set `DEV_SERVER_ID=<runtimeID>`
qua template substitution khi khởi động VM/container mới → `environment_id
= runtimeID` (đơn giản, dùng đúng ID đã có). Cần xác nhận:
- Template substitution (`{{instanceId}}` hay tương tự) có thật sự tồn
  tại trong `runRecipeCommand`/`EphemeralVmRecipeContext`/
  `ephemeral-vm-recipe-process.ts`'s `buildRecipeEnv` hay không — đọc
  source thật trước khi kết luận.
- Đây là thay đổi **hợp đồng với recipe author** — recipe cũ (chưa biết
  set `DEV_SERVER_ID`) sẽ không hoạt động đúng với tính năng này. Cần
  quyết định: bắt buộc, hay optional-with-fallback?

**Hướng 2** — `Provision`'s usecase chủ động polling/subscribe `dev_servers`
sau khi nhận `stream.end` để tìm row mới khớp (theo `Host`? theo 1
correlation id khác?). Cần xác nhận:
- Ephemeral VM's IP/host có ổn định/biết trước được không (để làm
  correlation key)?
- Độ trễ/race giữa `stream.end` và agent's `RegisterDevServer` thật sự
  hoàn tất — cần polling bao lâu, timeout bao nhiêu là hợp lý?

## Files liên quan (đọc để chốt quyết định, không nhất thiết phải sửa)

- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (`Provision`, đã code ở TASK-BE-EVM-004)
- `agent/src/shared/ephemeral-vm-recipe-process.ts` (`buildRecipeEnv` — xác nhận template substitution có/không)
- `agent/src/relay/agent-connection-direct.ts:69`, `agent-config.ts` (`DEV_SERVER_ID` env var, đã xác nhận ổn định qua reconnect — không cần audit lại)
- `backend-go/services/infra-fleet-service/internal/usecase/` — `ResolveDirectWebSocketDevServer`/`token_endpoint.go` (luồng đăng ký dev server thật, tách biệt)

## Kết quả mong đợi

Cập nhật trực tiếp vào [BE-SOL-EVM-003](../solutions/BE-SOL-EVM-003-environment-devserver-resolution.md)
với quyết định đã chốt (hướng 1, hướng 2, hoặc phương án thứ 3 nếu audit
lộ ra), kèm lý do — sau đó TASK-BE-EVM-006 có thể quay lại thành task code
thực thi được (bỏ BLOCKED).

## Verify

Không có lệnh build/test bắt buộc cho phần quyết định — nhưng nếu quyết
định là Hướng 1 và xác nhận được template substitution đã tồn tại thật,
NÊN tiếp tục implement luôn TASK-BE-EVM-006 trong cùng lượt (không tách
task quyết định + task code thành 2 lượt riêng nếu không cần thiết —
khác TASK-BE-EVM-009 vì đó liên quan tới 1 subsystem lớn (SSH2) chưa có
code nào, còn ở đây chỉ còn đúng `SetEnvironmentID` + 1 dòng gọi nó).

## Blocking

TASK-BE-EVM-006 (BLOCKED) phụ thuộc quyết định này để tiếp tục.
