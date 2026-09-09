# FE-SOL-EVM-003: Gọi `doctorRuntimeEphemeralVmRecipe` trước khi provision

> **🔲 Designed — chưa implement.** Hạ tầng có sẵn 100% cả 2 phía — chỉ
> nối dây.

**CR:** [CR-EVM-006](../../../../../../docs/crs/v3/ephemeral-vm/CR-EVM-006-wire-recipe-doctor.md)
**TDD tham chiếu:** [TDD-FE-03](../../../../tdd/v5/03-runtime-client-layer.md) §2

---

## 1. Trạng thái hiện tại (xác nhận chính xác)

`doctorRuntimeEphemeralVmRecipe(settings, {repoId, recipeId})`
(`runtime-ephemeral-vm-client.ts:91-99`) đã hoàn chỉnh — hybrid routing
local/`callRuntimeRpc` giống mọi hàm khác trong file, gọi
`window.api.ephemeralVm.doctor`/`ephemeralVm.doctor` channel thật
(`channels_ephemeral_vm.go:64`). Không gọi ở đâu trong UI.

`EphemeralVmsPane.tsx:131-135`'s `openWorkspaceComposerForRecipe` hiện
đồng bộ, không async:
```ts
const openWorkspaceComposerForRecipe = (repoId: string, recipeId: string): void => {
  openModal('new-workspace-composer', { initialRepoId: repoId, initialEphemeralVmRecipeId: recipeId, telemetrySource: 'settings' })
}
```
Gọi từ `EphemeralVmRecipeRow.tsx:301`'s `onUse={() =>
openWorkspaceComposerForRecipe(entry.repoId, recipe.id)}`.

## 2. Giải pháp

### Đổi `openWorkspaceComposerForRecipe` thành async, gọi doctor trước

```tsx
// EphemeralVmsPane.tsx
const openWorkspaceComposerForRecipe = async (repoId: string, recipeId: string): Promise<void> => {
  const diagnostics = await doctorRuntimeEphemeralVmRecipe(settings, { repoId, recipeId })
  const blocking = diagnostics.filter(isBlockingConflict) // xem mục "Đọc severity thật" dưới
  if (blocking.length > 0) {
    setConflictDialog({ repoId, recipeId, diagnostics }) // dialog block, nút "Xem chi tiết"/"Huỷ"
    return
  }
  if (diagnostics.length > 0) {
    const proceed = await confirmDialog({ diagnostics }) // warn-and-confirm cho conflict không blocking
    if (!proceed) return
  }
  openModal('new-workspace-composer', { initialRepoId: repoId, initialEphemeralVmRecipeId: recipeId, telemetrySource: 'settings' })
}
```

### Đọc severity thật trước khi code `isBlockingConflict`

**Bắt buộc đọc `doctorEphemeralVmRecipe`
(`frontend/src/shared/ephemeral-vm-recipe-doctor.ts:9-`) trước khi viết
UI** — xác nhận: kết quả trả về có phân loại severity (blocking vs warn)
hay tất cả cùng 1 mức? Nếu chỉ 1 mức, đơn giản hoá UI thành 1 loại dialog
duy nhất (warn-and-confirm), không tự bịa ra 2 mức không có trong data.

### Gọi lại doctor ngay trước `provision()` (defense in depth)

`ephemeral-vm-workspace-target.ts:45`'s `prepareEphemeralVmWorkspaceTarget`
— thêm 1 lời gọi `doctorRuntimeEphemeralVmRecipe` ngay đầu hàm, trước
`window.api.ephemeralVm.provision`. Nếu recipe không đổi từ lần gọi ở
bước trên (so sánh `recipeId` + có thể cache theo recipe content hash
nếu đo được overhead), có thể bỏ qua gọi lại — nhưng ưu tiên đúng (gọi
lại) hơn nhanh (cache) cho v1, tối ưu sau nếu cần.

### UI hiển thị kết quả

Dialog mới (hoặc banner inline trong composer) hiển thị `diagnostics`
list — tái dùng pattern dialog cảnh báo đã có trong
`NewWorkspaceComposerModal.tsx` (khảo sát trước khi tự vẽ mới).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Không dependency ngoài | Thấp | Cả backend lẫn wrapper đã có |
| Severity model của `doctorEphemeralVmRecipe` chưa xác nhận trong solution này | Trung bình | Đọc source thật trước khi code — xem mục 2 |
| Gọi doctor 2 lần tăng latency nhẹ | Thấp | Chấp nhận được cho v1 |

## Không thuộc phạm vi solution này

- Mở rộng bộ rule kiểm tra của `doctorEphemeralVmRecipe` — chỉ nối dây.

## Liên quan

- `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:91-99`
- `frontend/src/shared/ephemeral-vm-recipe-doctor.ts:9`
- `frontend/src/renderer/src/components/settings/EphemeralVmsPane.tsx:131-135`
- `frontend/src/renderer/src/components/settings/EphemeralVmRecipeRow.tsx:301`
- `frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.ts:45`
