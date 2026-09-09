# CR-EVM-006 — Nối `doctor` (recipe validation) vào UX provisioning

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-EVM-006 |
| **Tên** | Gọi `ephemeralVm.doctor` trước khi provision — đóng gap "capability mồ côi" |
| **Loại** | Bug Fix (capability có sẵn nhưng chưa dùng) |
| **Priority** | P2 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-09 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Audit trực tiếp mã nguồn sau khi xác nhận CR-EVM-001..005 đã Done |
| **Tác động HLD** | Infra-Fleet domain (đã có), Frontend workspace-composer flow |
| **Tác động Features** | F18 (Ephemeral VM) — tiêu chí chấp nhận "Recipe validation phát hiện conflicts trước khi tạo VM" |

---

## Bối cảnh & Vấn đề gốc

F18's tiêu chí chấp nhận
([`docs/features/F18-ephemeral-vm.md:56`](../../../features/F18-ephemeral-vm.md))
yêu cầu: "Recipe validation phát hiện conflicts trước khi tạo VM". Hạ
tầng cho việc này **đã tồn tại đầy đủ, chạy thật**:

- `frontend/src/shared/ephemeral-vm-recipe-doctor.ts:9` export
  `doctorEphemeralVmRecipe`.
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go:64` —
  `r.Register("ephemeralVm.doctor", ...)`, channel thật.
- `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:91-96` —
  client wrapper gọi channel trên.

Nhưng **không nơi nào trong sản phẩm gọi tới nó**. Grep mọi call site
không-phải-test của `.doctor(`/`ephemeralVm.doctor` trong
`frontend/src` và `agent/src` chỉ khớp chính định nghĩa wrapper. Cụ thể,
2 đường dẫn dẫn tới provision đều bỏ qua doctor:

- `EphemeralVmRecipeRow.tsx`'s `onUse` → `openWorkspaceComposerForRecipe`
  (dòng 301) — không gọi doctor trước khi mở composer.
- `ephemeral-vm-worktree-creation.ts` → `prepareEphemeralVmWorkspaceTarget`
  → thẳng tới `window.api.ephemeralVm.provision`
  (`ephemeral-vm-workspace-target.ts:45`) — không có bước validate.

## Giải pháp đề xuất

### Gọi `doctor` trước "Use in workspace"

Trong `EphemeralVmRecipeRow.tsx`'s `onUse` handler, gọi
`doctorEphemeralVmRecipe`/`ephemeralVm.doctor` (qua
`runtime-ephemeral-vm-client.ts`'s wrapper có sẵn) trước khi
`openWorkspaceComposerForRecipe`. Nếu doctor trả conflict:
- **Blocking** nếu conflict là loại không thể bỏ qua an toàn (theo
  đúng phân loại `doctorEphemeralVmRecipe` đã định nghĩa — kiểm tra
  shape kết quả trả về trước khi thiết kế UI, không tự đặt phân loại
  severity mới không khớp).
- **Warn-and-confirm** nếu conflict là cảnh báo mềm (vd. package version
  không khớp nhưng không chắc chắn gây lỗi).

### Gọi lại `doctor` ngay trước `provision()` (defense in depth)

`ephemeral-vm-workspace-target.ts`'s `prepareEphemeralVmWorkspaceTarget`
nên gọi lại `doctor` ngay trước `provision()` — không chỉ dựa vào lần
gọi ở bước chọn recipe (composer có thể mở lâu, recipe có thể đổi giữa
lúc chọn và lúc thật sự bấm tạo). Có thể cache kết quả doctor trong
composer state để tránh gọi trùng nếu recipe không đổi giữa 2 bước.

### UI hiển thị kết quả doctor

Thêm 1 dialog/inline banner hiển thị conflict list (nếu có) trong
workspace composer, theo đúng pattern dialog cảnh báo đã dùng ở nơi khác
trong `NewWorkspaceComposerModal.tsx` (không tự thiết kế pattern dialog
mới).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Không có dependency ngoài — cả backend lẫn wrapper đã có | Thấp | Đây là lý do priority P2 dù capability quan trọng — effort nhỏ |
| `doctorEphemeralVmRecipe`'s severity model chưa được audit kỹ trong CR này | Trung bình | Đọc kỹ implementation thật trước khi thiết kế UI blocking/warn — nếu mọi conflict hiện tại đều cùng 1 severity, UI có thể đơn giản hơn dự kiến |
| Gọi doctor 2 lần (chọn recipe + trước provision) tăng latency nhẹ | Thấp | Cache theo recipe id nếu đo được ảnh hưởng UX rõ rệt |

## Không thuộc phạm vi CR này

- Mở rộng `doctorEphemeralVmRecipe`'s bộ rule kiểm tra — CR này chỉ nối
  dây, không thêm rule conflict mới.

## Liên quan

- `frontend/src/shared/ephemeral-vm-recipe-doctor.ts:9`
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go:64`
- `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:91-96`
- `frontend/src/renderer/src/components/settings/EphemeralVmRecipeRow.tsx:301`
- `frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.ts:45`
