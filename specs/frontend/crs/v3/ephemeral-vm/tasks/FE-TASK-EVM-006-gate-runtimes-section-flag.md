# FE-TASK-EVM-006: Gate `<EphemeralVmRuntimesSection />` sau `experimentalEphemeralVms`

**Solution:** [FE-SOL-EVM-004](../solutions/FE-SOL-EVM-004-gate-runtimes-section-flag.md) | **CR:** CR-EVM-007
**Depends on:** Không
**Status:** ✅ DONE (2026-09-09)

---

## Mục tiêu

1-dòng-scale fix — đóng inconsistency gate flag.

## Files cần sửa

1. `frontend/src/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx` (MODIFY)

## Bước 1 — Xác nhận cách đọc `settings` trong component này

Kiểm tra `RuntimeEnvironmentsPane.tsx` nhận `settings` qua props hay đọc
từ `useAppStore` — dùng đúng cách phần còn lại của cùng component đã
đọc, không tạo cách đọc mới.

## Nội dung

```tsx
{settings.experimentalEphemeralVms === true && <EphemeralVmRuntimesSection />}
```
Thêm comment cảnh báo (xem FE-SOL-EVM-004 §2) giải thích lý do gate theo
Settings flag chứ không phải RPC availability.

## Test cases cần cover

- `experimentalEphemeralVms: false` → `EphemeralVmRuntimesSection` không render, `listRuntimes()` không được gọi.
- `experimentalEphemeralVms: true` → render bình thường, hành vi không đổi so với trước.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/components/settings/RuntimeEnvironmentsPane.test.tsx
npx tsc --noEmit
```

## gitnexus

`impact({target: "EphemeralVmRuntimesSection", direction: "upstream"})`.

---

## ✅ Kết quả thực tế (2026-09-09)

`settings: GlobalSettings` đã có sẵn qua props (`RuntimeEnvironmentsPane.tsx:64,247`)
— dùng thẳng, không cần đọc từ store. Sửa dòng 998 đúng theo sketch, thêm
comment cảnh báo.

**Verify**: `npx tsc --noEmit` — 0 lỗi. `npx vitest run
src/renderer/src/components/settings/RuntimeEnvironmentsPane.test.ts` —
7/7 pass (file test hiện tại chỉ test các pure helper function được
export, không có harness render component — không thêm được test
render-level "không gọi `listRuntimes()` khi cờ tắt" trong task này vì
thiếu harness RTL cho component này; ghi nhận là gap, không tự ý thêm
harness mới ngoài scope 1-dòng-fix).

**Files đã sửa:**
- `frontend/src/renderer/src/components/settings/RuntimeEnvironmentsPane.tsx` (MODIFY, dòng 998)
