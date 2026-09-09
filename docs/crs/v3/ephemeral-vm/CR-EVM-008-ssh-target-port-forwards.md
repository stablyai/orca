# CR-EVM-008 — Implement `portForwards` cho ephemeral VM SSH target

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-008 |
| **Tên** | Áp dụng `EphemeralVmRecipeSshTargetSchema.portForwards` thay vì bỏ qua có chủ đích |
| **Loại** | Feature Completion |
| **Priority** | P2 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn sau khi xác nhận CR-EVM-001..005 đã Done |
| **Tác động HLD** | Infra-Fleet domain, Agent SSH outbound transport (cả Hướng A và B từ CR-EVM-005) |
| **Tác động Features** | F18 (Ephemeral VM) — "Port forwarding từ VM về local" |

---

## Bối cảnh & Vấn đề gốc

F18's spec
([`docs/features/F18-ephemeral-vm.md:47`](../../../features/F18-ephemeral-vm.md))
liệt "Port forwarding từ VM về local" như 1 phần "Integration với
Worktrees". Schema đã có chỗ cho việc này:
`EphemeralVmRecipeSshTargetSchema.portForwards`
(`frontend/src/shared/ephemeral-vm-recipes.ts:38-44,70`) chấp nhận
`SavedPortForward[]`.

Nhưng field này **bị bỏ qua có chủ đích** ở cả 2 điểm decode phía Go:

```go
// backend-go/.../usecase/ports.go:497
// configHost/portForwards deliberately omitted, see infrafleet.proto's
// EphemeralVmRecipeSshTarget message doc comment

// backend-go/.../devserveragent/client.go:704
// (cùng comment)
```

`agent/src/relay/ssh-outbound-client.ts` (CR-EVM-005's Hướng A) không có
tham chiếu nào tới `portForwards`. Không có code nào ở Hướng B
(`ephemeralsshconn`/`backendrelaysshprovisioner`) áp dụng forward. Đây là
quyết định hoãn ghi rõ trong comment, nhưng **chưa từng được track bằng
1 CR** để quay lại làm — CR này đóng khoảng trống đó.

## Giải pháp đề xuất

### Proto

Thêm field thật vào `EphemeralVmRecipeSshTarget` message
(`infrafleet.proto`) — hiện `portForwards` chỉ tồn tại ở tầng TS schema,
chưa có mặt trong proto Go dùng để truyền giữa backend-go và agent (đây
là lý do 2 điểm decode phải "deliberately omit" — trường đó chưa qua
được proto). Đọc kỹ message doc comment hiện tại
(được cả 2 comment trên trỏ tới) trước khi thêm field, giữ đúng lý do
thiết kế đã ghi ở đó.

### Agent — Hướng A (`ssh-outbound-client.ts`)

SSH2 outbound client (CR-EVM-005) cần thêm local/remote port-forward
setup sau khi connect — dùng API forward có sẵn của thư viện SSH2 đang
dùng (không viết TCP proxy tay). Forward list lấy từ `portForwards` mới
thêm ở proto.

### Agent/backend-go — Hướng B (`ephemeralsshconn`/`backendrelaysshprovisioner`)

Tương tự, thêm bước setup forward vào flow provision của Hướng B (mode
mặc định theo `EPHEMERAL_VM_SSH_MODE`, xem CR-EVM-005's cập nhật) — cả 2
hướng phải support để không tạo thêm 1 sự khác biệt hành vi mới giữa 2
mode.

### UI

Nếu recipe author cấu hình `portForwards`, workspace UI nên hiển thị
port đã forward (tương tự cách sản phẩm đã hiển thị port forward cho dev
server thường — tái dùng component hiển thị đó nếu có, không tự thiết kế
UI mới).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Cần touch cả 2 hướng SSH (A và B) | Trung bình | Effort tăng gấp đôi so với chỉ 1 hướng — nhưng bỏ qua 1 hướng sẽ tạo lệch hành vi giữa `EPHEMERAL_VM_SSH_MODE` config, không chấp nhận được |
| Đổi proto message đã ship (`EphemeralVmRecipeSshTarget`) | Trung bình | README's "Nguyên tắc thiết kế xuyên suốt" #4 (giữ nguyên `OrcaVmRecipe`/`EphemeralVmRecipeSshTargetSchema`) áp dụng cho **contract JSON** dùng chung 3 tầng — thêm field mới (không đổi field cũ) là mở rộng tương thích ngược, không vi phạm nguyên tắc đó |
| Forward port trùng với port cục bộ đã dùng | Thấp | Cần xử lý lỗi rõ ràng (port conflict), không silent fail |

## Không thuộc phạm vi CR này

- Container runtime's port forwarding (nếu CR-EVM-011 được làm sau này)
  — CR này chỉ cho `connection_type: 'ssh'`.

## Liên quan

- `frontend/src/shared/ephemeral-vm-recipes.ts:38-44,70` (`portForwards` schema)
- `backend-go/.../usecase/ports.go:497`, `backend-go/.../devserveragent/client.go:704` (điểm bỏ qua có chủ đích)
- `agent/src/relay/ssh-outbound-client.ts` (Hướng A)
- `backendrelaysshprovisioner/provisioner.go`, `ephemeralsshconn/connector.go` (Hướng B)
- [CR-EVM-005](./CR-EVM-005-ssh-connection-type-outbound-client.md) (nền tảng cả 2 hướng, đã Done)
