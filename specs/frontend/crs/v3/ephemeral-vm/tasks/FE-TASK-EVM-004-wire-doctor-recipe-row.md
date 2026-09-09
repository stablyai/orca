# FE-TASK-EVM-004: Gọi `doctorRuntimeEphemeralVmRecipe` trước "Use in workspace"

**Solution:** [FE-SOL-EVM-003](../solutions/FE-SOL-EVM-003-wire-recipe-doctor.md) | **CR:** CR-EVM-006
**Depends on:** Không
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

`openWorkspaceComposerForRecipe` (đồng bộ hôm nay) → async, gọi doctor
trước khi mở composer, hiển thị conflict nếu có.

## Files cần sửa

1. `frontend/src/renderer/src/components/settings/EphemeralVmsPane.tsx` (MODIFY)
2. `frontend/src/renderer/src/components/settings/EphemeralVmConflictDialog.tsx` (MỚI)

## Bước 1 — Đọc severity model thật trước khi code

Đọc `frontend/src/shared/ephemeral-vm-recipe-doctor.ts:9-` xác nhận:
kết quả có phân loại blocking/warn hay 1 mức duy nhất. Điều chỉnh UI
theo đúng data thật, không tự bịa 2 mức nếu chỉ có 1.

## Nội dung (xem FE-SOL-EVM-003 §2)

```tsx
const openWorkspaceComposerForRecipe = async (repoId: string, recipeId: string): Promise<void> => {
  const diagnostics = await doctorRuntimeEphemeralVmRecipe(settings, { repoId, recipeId })
  if (diagnostics.length > 0) {
    const proceed = await showConflictDialog(diagnostics) // hoặc block cứng, tuỳ Bước 1
    if (!proceed) return
  }
  openModal('new-workspace-composer', { initialRepoId: repoId, initialEphemeralVmRecipeId: recipeId, telemetrySource: 'settings' })
}
```

## Test cases cần cover

- Recipe không có conflict → composer mở ngay, không hiện dialog.
- Recipe có conflict (blocking) → dialog hiện, composer không mở cho tới khi resolve/huỷ.
- Recipe có conflict (warn) → dialog xác nhận, "Tiếp tục" → composer mở.
- Lỗi khi gọi doctor (network/RPC lỗi) → không crash, thông báo lỗi rõ ràng, không mở composer im lặng.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/settings/EphemeralVmsPane.test.tsx
npx tsc --noEmit
```

## gitnexus

`impact({target: "doctorRuntimeEphemeralVmRecipe", direction: "upstream"})`
trước khi thêm call site mới.

---

## ✅ Kết quả thực tế (2026-09-09)

Bước 1 xác nhận: `EphemeralVmRecipeDoctorResult.ok` = `checks.every(c =>
c.status !== 'fail')` (`ephemeral-vm-recipe-doctor.ts:167`) — 3 mức thật:
`pass`/`warn`/`fail`. Dùng đúng model này: `ok:false` → dialog blocking
(không có nút "Continue anyway"); `ok:true` + có `warn` → dialog
warn-and-confirm; toàn `pass` → mở composer thẳng.

- Thêm `EphemeralVmRecipeDoctorDialog.tsx` (component chung, theo pattern
  `OrcaProfileSwitchConfirmDialog.tsx` — Dialog/DialogHeader/DialogFooter).
- `EphemeralVmsPane.tsx`: `openWorkspaceComposerForRecipe` → async, gọi
  `doctorRuntimeEphemeralVmRecipe(settings, {repoId, recipeId})` trước
  `openModal`; state `doctorDialog` giữ kết quả khi cần hỏi/chặn.
- **Phát hiện quan trọng khi viết test**: file test
  `EphemeralVmsPane.test.tsx` **đã có sẵn mock `doctor: vi.fn()...`**
  trước khi task này chạy — cho thấy việc wire này đã được dự tính từ
  trước, không phải thiết kế mới hoàn toàn.
- Dialog render qua Radix `Portal` vào `document.body`, không nằm trong
  `container` — test phải query `document.body`, không phải
  `container.textContent` (lỗi ban đầu khi viết test, đã sửa).

**Verify**: `npx tsc --noEmit` — 0 lỗi. `npx oxlint` — 0 lỗi, 0 warning.
`npx vitest run src/renderer/src/components/settings/EphemeralVmsPane.test.tsx`
— 3/3 pass (1 test cũ + 2 test mới: blocking fail, warn-and-continue).

**Files đã sửa/tạo:**
- `frontend/src/renderer/src/components/settings/EphemeralVmRecipeDoctorDialog.tsx` (MỚI)
- `frontend/src/renderer/src/components/settings/EphemeralVmsPane.tsx` (MODIFY)
- `frontend/src/renderer/src/components/settings/EphemeralVmsPane.test.tsx` (MODIFY — thêm 2 test)
