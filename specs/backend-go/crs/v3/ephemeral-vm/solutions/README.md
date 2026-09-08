# backend-go Solutions — Ephemeral VM

**CRs:** [docs/crs/v3/ephemeral-vm/](../../../../../../docs/crs/v3/ephemeral-vm/README.md)
**Frontend counterpart:** [specs/frontend/crs/v3/ephemeral-vm/solutions/](../../../../frontend/crs/v3/ephemeral-vm/solutions/README.md)
**Agent counterpart:** [specs/agent/crs/v3/ephemeral-vm/solutions/](../../../../agent/crs/v3/ephemeral-vm/solutions/README.md)
**TDD tham chiếu:** [`infra-fleet-service.md`](../../../../tdd/services/infra-fleet-service.md) §3, §5, §7 (connectionId resolution flow); [`api-gateway.md`](../../../../tdd/services/api-gateway.md) §8 (WS↔gRPC streaming bridge)

## Solutions

| Solution | CR | Service | Status |
|---|---|---|---|
| [BE-SOL-EVM-001](./BE-SOL-EVM-001-agent-vm-exec-params.md) | CR-EVM-001 | `infra-fleet-service` | 🔲 Designed — chưa implement |
| [BE-SOL-EVM-002](./BE-SOL-EVM-002-provision-streaming-channel.md) | CR-EVM-003 | `infra-fleet-service`, `api-gateway` | 🔲 Designed — chưa implement |
| [BE-SOL-EVM-003](./BE-SOL-EVM-003-environment-devserver-resolution.md) | CR-EVM-004 | `infra-fleet-service`, `api-gateway` | 🔲 Designed — chưa implement |
| [BE-SOL-EVM-004](./BE-SOL-EVM-004-ssh-connection-type-backend.md) | CR-EVM-005 (phần backend-go) | `infra-fleet-service` | 🔲 Designed — chưa implement |

## Phát hiện quan trọng khi đối chiếu TDD với mã nguồn thật

`infra-fleet-service.md` §7's "connectionId resolution + relay dispatch
flow" mô tả đúng khung `ResolveConnection` → cache/Postgres →
`ProviderRegistryEntry` → relay tới agent — **BE-SOL-EVM-003 dùng chính
khung này**, chỉ thêm 1 nhánh alias `environmentId → dev_server_id` trước
bước `ResolveConnection`. Không lệch TDD.

`api-gateway.md` §8 mô tả "WS ↔ gRPC-stream bridging" ở mức **khái niệm**
(1 WS endpoint ↔ 1 gRPC streaming call) nhưng **không nhắc tới
`Registry.StreamChannelHandler`/`PushEvent`** — cơ chế thật, cụ thể hơn,
đã tồn tại trong `wscompat/registry.go` và có tiền lệ chạy production
(`onboarding.openGhAuthTerminal`, `terminal.multiplex`,
`browser.screencast`). TDD mô tả đúng Ý ĐỊNH kiến trúc nhưng ở mức trừu
tượng cao hơn implementation thật — BE-SOL-EVM-002 dùng implementation
thật (`StreamChannelHandler`), không phát minh cơ chế mới, và nên được
xem là bản cập nhật chi tiết hoá cho phần "WS ↔ gRPC-stream bridging" của
TDD, không phải đi chệch khỏi nó.

## Thứ tự implement

```
BE-SOL-EVM-001 → độc lập, sửa 1 tham số thiếu trong lời gọi vm.exec đã có
                 sẵn — làm ngay, không phụ thuộc gì
BE-SOL-EVM-002 → nền tảng lớn nhất (StreamChannelHandler mới +
                 DevServerAgentClient.StreamVmProvision + proto) — không
                 phụ thuộc BE-SOL-EVM-001, nhưng dùng chung
                 agent-ephemeral-vm-handler.ts phía agent nên nên làm sau
                 SOL-AG-EVM-001 (agent counterpart của BE-SOL-EVM-001)
BE-SOL-EVM-003 → phụ thuộc CỨNG BE-SOL-EVM-002 (cần provision pairing
                 thành công để có gì mà ghi environment_id) — làm sau cùng
BE-SOL-EVM-004 → độc lập kỹ thuật, chỉ có ý nghĩa sau khi
                 SOL-AG-EVM-003 (agent outbound SSH client) tồn tại —
                 làm sau, không chặn 001-003
```

## Nguyên tắc bảo mật xuyên suốt (kế thừa từ nhóm CR-STORAGE)

`tenantID`/`userID` cho mọi usecase mới ở đây **luôn lấy từ
`tenant.RequireTenantID(ctx)`/`Identity` đã xác thực** — không bao giờ từ
`args`/request field do client gửi, đúng quy tắc đã kiểm chứng ở
`BE-SOL-STORAGE-001`/`002` và `tenant-service.md` §9. `EphemeralVmRelay`
hiện tại đã tuân thủ đúng quy tắc này (`tenant.RequireTenantID(ctx)` ở
mọi method) — 4 solution dưới đây tiếp tục đúng pattern, không nới lỏng.
