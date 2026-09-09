# FE-TASK-EVM-005: Gọi lại doctor ngay trước `provision()` (defense in depth)

**Solution:** [FE-SOL-EVM-003](../solutions/FE-SOL-EVM-003-wire-recipe-doctor.md) | **CR:** CR-EVM-006
**Depends on:** [FE-TASK-EVM-004](./FE-TASK-EVM-004-wire-doctor-recipe-row.md)
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

Recipe có thể đổi giữa lúc chọn (FE-TASK-EVM-004) và lúc thật sự bấm
tạo — gọi lại doctor ngay trước `provision()`.

## Files cần sửa

1. `frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.ts` (MODIFY — `prepareEphemeralVmWorkspaceTarget`, dòng ~45)

## Nội dung

Thêm lời gọi `doctorRuntimeEphemeralVmRecipe` ngay đầu hàm, trước
`window.api.ephemeralVm.provision`. Nếu conflict phát hiện, ném lỗi rõ
ràng (không tự động tiếp tục) — người dùng đã qua bước xác nhận ở
FE-TASK-EVM-004, lần gọi lại này chỉ là an toàn bổ sung khi recipe đổi
đột ngột.

## Test cases cần cover

- Recipe không đổi từ lúc chọn → provision tiến hành bình thường.
- Recipe bị đổi (giả lập bằng cách sửa recipe giữa 2 bước trong test) → phát hiện conflict mới, chặn provision, thông báo rõ ràng.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/lib/ephemeral-vm-workspace-target.test.ts
npx tsc --noEmit
```

## gitnexus

`impact({target: "prepareEphemeralVmWorkspaceTarget", direction: "upstream"})`.

---

## ✅ Kết quả thực tế (2026-09-09)

Chỉ chặn khi có `fail` (defense-in-depth, `warn` đã được xác nhận ở
FE-TASK-EVM-004's bước trước) — trả `{ok: false, error: <fail messages
joined>, stderr: ''}` trước khi gọi `window.api.ephemeralVm.provision`,
không cleanup runtime nào cần thiết (chưa có runtime nào được tạo ở
điểm này).

2 file test hiện có (`ephemeral-vm-workspace-target.test.ts`,
`.integration.test.ts`) đều mock `window.api.ephemeralVm` KHÔNG có
`doctor` — phải thêm `doctor: vi.fn().mockResolvedValue({ok:true,
checks:[]})` vào cả 2 file để không phá test hiện có, theo đúng dự tính
ở solution's rủi ro chung.

**Verify**: `npx tsc --noEmit` — 0 lỗi. `npx vitest run
src/renderer/src/lib/ephemeral-vm-workspace-target.test.ts
src/renderer/src/lib/ephemeral-vm-workspace-target.integration.test.ts`
— 9/9 pass (8 test cũ + 1 test mới: doctor fail chặn provision).

**Files đã sửa:**
- `frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.ts` (MODIFY)
- `frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.test.ts` (MODIFY — thêm `doctor` mock + 1 test)
- `frontend/src/renderer/src/lib/ephemeral-vm-workspace-target.integration.test.ts` (MODIFY — thêm `doctor` mock)
