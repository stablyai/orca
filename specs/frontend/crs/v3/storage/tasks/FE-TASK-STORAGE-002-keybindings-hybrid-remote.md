# FE-TASK-STORAGE-002: `keybindings.ts` — nhánh remote + seed 1 lần

**Solution:** FE-SOL-STORAGE-001 | **CR:** CR-STORAGE-001
**Depends on:** FE-TASK-STORAGE-001
**Status:** ✅ DONE (2026-09-07)

**Kết quả thực tế:** Codebase thật không có `loadKeybindings()`/`setAction()` như doc mô tả — tên
thật là `fetchKeybindings()` và 3 hàm mutate riêng (`setKeybindingOverride`, `resetKeybindingOverride`,
`disableKeybindingAction`), state thật cũng có thêm `keybindingSnapshot: KeybindingFileSnapshot | null`
(desktop file-based, không chỉ `KeybindingOverrides`). Áp dụng đúng pattern hybrid (branch
`target.kind !== 'environment'` giữ nguyên 100%) cho cả 4 hàm — nhánh remote dùng
`applyRemoteOverrides()` set `keybindingSnapshot: null` (component `ShortcutsPane`/
`hasCommonBindingOverride` đã tolerate null). Seed-once logic đúng như thiết kế. Nhánh remote
KHÔNG gọi `window.api.keybindings.setAction` — chỉ mutate state + queue write (xem
FE-TASK-STORAGE-005 cho phần ghi thật vào backend-go).

`npx vitest run src/renderer/src/store/slices/keybindings.test.ts`: **7/7 pass** (4 test desktop-local
không đổi hành vi + 3 test remote mới).

---

## Mục tiêu

Desktop giữ nguyên 100% `window.api.keybindings.*`; thêm nhánh
`target.kind === 'environment'` đọc/ghi qua `runtimeClientState`, có seed
dữ liệu cũ 1 lần khi backend-go chưa có bản ghi.

## Files cần sửa

1. `frontend/src/renderer/src/store/slices/keybindings.ts` (MODIFY)
2. `frontend/src/renderer/src/store/slices/keybindings.test.ts` (MODIFY — thêm test case nhánh remote)

## Nội dung (xem FE-SOL-STORAGE-001 §3, §6 cho code đầy đủ)

`loadKeybindings()` và `setAction()` thêm nhánh `if (target.kind !==
'environment') { ...window.api... return }` giữ nguyên, else gọi
`runtimeClientState`. `loadKeybindings()` thêm seed: nếu
`runtimeClientState.get('keybindings')` trả `null`, gọi
`window.api.keybindings.get()` rồi `runtimeClientState.set('keybindings',
local)` 1 lần.

## Test cases cần cover

- Desktop (`target.kind === 'local'`): hành vi **không đổi** — test case cũ
  phải pass nguyên vẹn, không sửa.
- Web/paired lần đầu (backend-go chưa có bản ghi): `loadKeybindings()` gọi
  `window.api.keybindings.get()` để seed, rồi gọi `runtimeClientState.set`,
  set state đúng bằng bản local.
- Web/paired đã có bản ghi: `loadKeybindings()` dùng thẳng bản remote,
  KHÔNG gọi `window.api.keybindings.get()`.
- `setAction()` ở nhánh remote gọi `runtimeClientState.set('keybindings', ...)`,
  KHÔNG gọi `window.api.keybindings.setAction`.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/store/slices/keybindings.test.ts
```

## gitnexus

`impact({target: "loadKeybindings", direction: "upstream"})` và
`impact({target: "setAction", direction: "upstream"})` (namespace
keybindings slice) trước khi sửa — xác nhận danh sách component gọi 2 hàm
này, đảm bảo không component nào giả định hành vi đồng bộ (cả 2 hàm vẫn
`async`, không đổi signature).

## Blocking

Không.
