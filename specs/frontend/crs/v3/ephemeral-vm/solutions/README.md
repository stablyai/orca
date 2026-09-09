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

> **Cập nhật 2026-09-09 — FE-SOL-EVM-001..002 đã ✅ Done.** CR-EVM-002/003
> đã xác nhận code xong (`80ffe57cd`) — xem
> [docs/crs/v3/ephemeral-vm/README.md](../../../../../../docs/crs/v3/ephemeral-vm/README.md).
> 4 solution mới dưới đây (003-006) là cho CR-EVM-006..010 — nhóm audit
> mới, chưa triển khai.

| [FE-SOL-EVM-003](./FE-SOL-EVM-003-wire-recipe-doctor.md) | CR-EVM-006 | 🔲 Designed — chưa implement |
| [FE-SOL-EVM-004](./FE-SOL-EVM-004-gate-runtimes-section-flag.md) | CR-EVM-007 | 🔲 Designed — chưa implement |
| [FE-SOL-EVM-005](./FE-SOL-EVM-005-worktree-mount-decision-memo.md) | CR-EVM-009 (decision memo) | 🔲 Blocked — chờ quyết định sản phẩm |
| [FE-SOL-EVM-006](./FE-SOL-EVM-006-auto-destroy-on-task-completion.md) | CR-EVM-010 | 🔲 Designed — chưa implement |

CR-EVM-008 (agent+backend-go only) không có solution frontend. CR-EVM-011
chưa xác nhận scope.

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

── nhóm 003-006 (CR-EVM-006..010, sau khi 001-002 đã Done) ──────────────

FE-SOL-EVM-003 → độc lập hoàn toàn, làm bất cứ lúc nào
FE-SOL-EVM-004 → độc lập hoàn toàn, ưu tiên cao (rẻ, đóng inconsistency
                 rõ ràng) — làm bất cứ lúc nào
FE-SOL-EVM-005 → BLOCKED — không code cho tới khi CR-EVM-009's quyết
                 định sản phẩm chốt
FE-SOL-EVM-006 → phụ thuộc vào việc xác nhận tín hiệu `AgentDetector` có
                 phù hợp không (mục 2 của solution) — phối hợp với
                 FE-AUTO-SOL-005 (nhóm Automations, cùng câu hỏi)
```
