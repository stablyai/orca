# frontend Solutions — Ephemeral VM

**CRs:** [docs/crs/v3/ephemeral-vm/](../../../../../../docs/crs/v3/ephemeral-vm/README.md)
**backend-go counterpart:** [specs/backend-go/crs/v3/ephemeral-vm/solutions/](../../../../backend-go/crs/v3/ephemeral-vm/solutions/README.md)
**Agent counterpart:** [specs/agent/crs/v3/ephemeral-vm/solutions/](../../../../agent/crs/v3/ephemeral-vm/solutions/README.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2 (Runtime RPC Client), §6 (Remote Runtime Terminal Multiplexer — precedent streaming client gần nhất)

## Solutions

| Solution | CR | Status |
|---|---|---|
| [FE-SOL-EVM-001](./FE-SOL-EVM-001-remove-stale-suppressor-and-routing-audit.md) | CR-EVM-002 | 🔲 Designed — chưa implement |
| [FE-SOL-EVM-002](./FE-SOL-EVM-002-provision-streaming-client.md) | CR-EVM-003 (phần frontend) | 🔲 Designed — chưa implement |

## Phát hiện khi đối chiếu TDD với mã nguồn thật

`TDD-FE-03` §2's `callRuntimeRpc` (đọc trực tiếp
`runtime-rpc-client.ts:68-` — không chỉ tin TDD) xác nhận: đây là 1 hàm
request/response **thuần** (`Promise<TResult>`), không có tham số/overload
nào cho subscribe/push. §6's `RemoteRuntimeTerminalMultiplexer` là
streaming client **duy nhất** hiện có, nhưng gắn chặt với
`terminal.multiplex`'s binary opcode-tagged protocol (per
`backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal_multiplex.go`'s
header comment) — không phải 1 lớp generic cho bất kỳ
`StreamChannelHandler`-shaped channel nào. **Kết luận: chưa có sẵn client
generic để tái dùng cho `ephemeralVm.provision`** — FE-SOL-EVM-002 cần
viết mới, không chỉ gọi lại 1 helper có sẵn.

## Thứ tự implement

```
FE-SOL-EVM-001 → độc lập hoàn toàn, 1 dòng đổi + audit — làm sớm, không
                 phụ thuộc backend-go/agent nào xong trước (9 method đã
                 port từ SOL-004/TASK-005 rồi)
FE-SOL-EVM-002 → phụ thuộc CỨNG BE-SOL-EVM-002 (backend-go) và
                 SOL-AG-EVM-002 (agent) đã tồn tại để có gì mà gọi/test —
                 làm sau
```
