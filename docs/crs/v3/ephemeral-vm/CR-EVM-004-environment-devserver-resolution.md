# CR-EVM-004 — Resolve `environmentId` bare thành dev server thật sau khi `provision` pairing

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-004 |
| **Tên** | Ghi `environment_id` khi `provision` pairing thành công; unblock `terminal.create`/`files.browseServerDir` |
| **Loại** | Feature Completion (đóng backlog item đã có sẵn) |
| **Priority** | P2 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-08 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai, phụ thuộc cứng [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) |
| **Tác giả** | Kế thừa thiết kế đã có ở `docs/backlog/BACKLOG-002-environment-devserver-resolution.md`, xác nhận lại bằng mã nguồn hiện tại |
| **Tác động HLD** | Infra-Fleet domain (`ResolveConnection`), Terminal RPC surface |
| **Tác động Features** | `terminal.create`, `files.browseServerDir` cho workspace backed thuần bởi ephemeral VM (chưa gắn compute cụ thể) |

---

## Bối cảnh & Vấn đề gốc

Đây là nội dung của
[BACKLOG-002](../../../../docs/backlog/BACKLOG-002-environment-devserver-resolution.md),
giờ **không còn bị block nữa** một khi
[CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) tồn tại — CR này
hiện thực hoá đúng thiết kế đã sketch ở đó, không phát minh lại.

`infra.ephemeral_vm_runtimes` đã có cột `environment_id`
(`backend-go/services/infra-fleet-service/migrations/0013_ephemeral_vm_runtimes.up.sql:9`):

```sql
environment_id  TEXT,  -- set once an orca-server-type recipe's pairing succeeds; NULL for ssh-type
```

Trước CR-EVM-003, không code path nào từng pairing thành công nên cột
này luôn `NULL` — khiến 2 RPC hard-fail cho 1 `runtime:<environmentId>`
bare (workspace chỉ backed bởi ephemeral VM, chưa gắn compute):

- `terminal.create` → `INFRA_TERMINAL_NO_COMPUTE_BOUND`
  (`spawn_terminal_session.go` — lỗi sạch, có chủ đích, không phải bug).
- `files.browseServerDir` → rơi vào `notImplementedHandler` — chưa có
  channel đăng ký.

## Giải pháp đề xuất

### 1. `environment_id = dev_server_id` — không thêm bảng/khái niệm mới

Khi `provision` (CR-EVM-003) nhận `{type: 'orca-server', pairingCode,
projectRoot}` từ agent và pairing với Orca thành công qua
`agent-connection-direct.ts`'s outbound-dial mode (agent tự đặt
`devServerId`), dùng **chính id của `ephemeral_vm_runtimes` row đó** (hoặc
1 id mới ghi ngược lại row) làm `devServerId`. Khi agent dial vào, nó
đăng ký vào `infra.connections` **y hệt 1 dev server bình thường** —
không cần bảng "environment resolution" mới. `environment_id` khi đó
**bằng luôn** `dev_server_id` (1 cột, không phải 2).

### 2. Tận dụng `ResolveConnectionRequest`'s `dev_server_id` alternate-key — đã tồn tại, đã chạy thật

Không cần đổi proto. `infrafleet.proto`'s `ResolveConnectionRequest` đã
hỗ trợ `dev_server_id` như alternate-key cho `connection_id` — xác nhận
bằng call site thật, không phải suy đoán:

```go
// channels_onboarding.go:654 — tiền lệ đang chạy production
client.ResolveConnection(invokeCtx, &infrafleetv1.ResolveConnectionRequest{DevServerId: in.DevServerID})
```

`SpawnTerminalSession`'s resolution logic (đã có primitive alternate-key
resolution) chỉ cần nhận thêm `environmentId` như 1 alias tra cứu ra
`dev_server_id` (qua `ephemeral_vm_runtimes.environment_id`) trước khi
gọi `ResolveConnection` — không đổi `SpawnTerminalSessionRequest`'s proto
shape.

### 3. `files.browseServerDir` — channel mới, relay theo đúng mẫu SSH/dev-server-bound đã có

Đăng ký channel `files.browseServerDir` (hiện chưa tồn tại) trong
`wscompat`, dùng cùng cơ chế `devServer.browseDir`-style agent call các
path SSH/dev-server-bound khác đã dùng — resolve `environmentId` →
`devServerId` bằng đúng bước (2) ở trên trước khi relay.

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng CR-EVM-003 | Cao nếu làm trước | Không có gì để resolve nếu `provision` chưa từng pairing thành công — CR này PHẢI làm sau CR-EVM-003 |
| Không tự chế bảng `environment_bindings` mới | — | Cảnh báo rõ từ BACKLOG-002: mọi thiết kế thay thế (bảng mới, resolution path riêng cho từng RPC) sẽ trùng lặp với thiết kế `provision` đã chốt — không làm |
| `environmentId` với binding không tồn tại (chưa provision) | Thấp | Phải tiếp tục trả `INFRA_TERMINAL_NO_COMPUTE_BOUND` — đây là hành vi đúng (unprovisioned environment), không phải regression cần sửa |

## Không thuộc phạm vi CR này

- Bản thân `provision` — xem [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md).
- `ssh`-type ephemeral VM's resolution (environment_id NULL theo thiết kế cho nhánh này) — xem [CR-EVM-005](./CR-EVM-005-ssh-connection-type-outbound-client.md).

## Verify (theo đúng kế hoạch BACKLOG-002 đã sketch)

- `spawn_terminal_session_test.go`: 1 `environmentId` có binding resolvable rơi vào đúng nhánh thành công devServerId hiện có; 1 `environmentId` không có binding vẫn trả `INFRA_TERMINAL_NO_COMPUTE_BOUND`.
- Test mới cho `files.browseServerDir` channel, relay đúng tới cùng `devServer.browseDir`-style agent call các path SSH/dev-server-bound khác đã dùng.

## Liên quan

- `docs/backlog/BACKLOG-002-environment-devserver-resolution.md` (thiết kế gốc, CR này hiện thực hoá)
- `backend-go/services/infra-fleet-service/migrations/0013_ephemeral_vm_runtimes.up.sql:9`
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (`ResolveConnectionRequest`)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:654` (tiền lệ `dev_server_id` alternate-key đang chạy thật)
- [CR-EVM-003](./CR-EVM-003-provision-streaming-rpc.md) (phụ thuộc cứng)
