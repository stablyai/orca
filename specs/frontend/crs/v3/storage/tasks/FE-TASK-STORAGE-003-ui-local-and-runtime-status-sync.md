# FE-TASK-STORAGE-003: `ui.ts` (uiLocal) + `runtime-status.ts` (saved server list) — đồng bộ song song

**Solution:** FE-SOL-STORAGE-001 | **CR:** CR-STORAGE-001
**Depends on:** FE-TASK-STORAGE-001
**Status:** ✅ DONE (2026-09-07)

**Kết quả thực tế:**

- `ui.ts`: `toPersistedUIState()` chọn 34 field (không phải toàn bộ ~80 field của
  `PersistedUIState`) — loại trừ window geometry (`windowBounds`, `sidebarWidth`, zoom levels...),
  field keyed theo worktree/pane id cục bộ (`lastActiveWorktreeId`, `showDotfilesByWorktree`...),
  toàn bộ migration flag `_`-prefixed, và update/star-nag state theo version cài đặt — lý do chi
  tiết viết thành comment ngay trong `toPersistedUIState`'s doc comment (dễ review). Gọi song song
  `runtimeClientState.set('uiLocal', ...)` được thêm vào `toggleCollapsedGroup` (action đại diện
  đúng `uiSet(...)` mẫu trong solution) — fire-and-forget, KHÔNG chặn hành vi gốc kể cả khi RPC
  reject.
- `runtime-status.ts`: thêm `mergeById()` (remote chỉ bổ sung, không ghi đè xoá cục bộ — đúng
  policy tạm đã ghi trong task doc) + merge vào `hydrateRuntimeEnvironmentStatuses()`. Việc "save"
  gộp vào `setRuntimeEnvironments()` (điểm mutate list duy nhất, mọi caller add/remove/pairing đều
  đi qua đây) thay vì thêm 1 action `saveRuntimeEnvironment` mới không tồn tại trong codebase thật.

`npx vitest run src/renderer/src/store/slices/ui.test.ts src/renderer/src/store/slices/runtime-status.test.ts`:
**172/172 pass** (152 ui.test.ts, trong đó 8 test mới; 20 runtime-status.test.ts, trong đó 6 test mới).

---

## Mục tiêu

Thêm 1 lời gọi `runtimeClientState.set`/`get` song song (không chặn) bên
cạnh cơ chế `uiSet`/`window.api.runtimeEnvironments.*` đã có — KHÔNG thay
thế RPC `ui.*` hiện tại (xem FE-SOL-STORAGE-001 §4 để tránh nhầm lẫn 2 cơ
chế).

## Files cần sửa

1. `frontend/src/renderer/src/store/slices/ui.ts` (MODIFY — thêm `toPersistedUIState()` selector + gọi song song trong action đã có `uiSet(...)`)
2. `frontend/src/renderer/src/store/slices/runtime-status.ts` (MODIFY — merge saved list từ `savedRuntimeEnvironments`)
3. Test file tương ứng cho cả 2

## Nội dung (xem FE-SOL-STORAGE-001 §4, §5)

`ui.ts`: xác định trước tiên **field nào** trong `PersistedUIState` là
"cần bền qua cài lại" (KHÔNG phải toàn bộ 80 field — loại trừ
`windowBounds` và field chỉ có ý nghĩa cho đúng 1 máy, xem "Rủi ro" của
solution) — viết `toPersistedUIState()` trả về subset đó, rồi thêm
`void runtimeClientState.set('uiLocal', get().toPersistedUIState())`
ngay sau lời gọi `uiSet(...)` đã có.

`runtime-status.ts`: `loadSavedRuntimeEnvironments()` thêm merge từ
`runtimeClientState.get('savedRuntimeEnvironments')` khi
`target.kind === 'environment'`; `saveRuntimeEnvironment()` thêm
`runtimeClientState.set('savedRuntimeEnvironments', ...)` sau
`window.api.runtimeEnvironments.save(...)`.

## Test cases cần cover

- `toPersistedUIState()` trả đúng subset field đã xác định — viết test
  snapshot rõ ràng field nào có/không có, để review dễ dàng.
- `ui.ts`'s action gọi `uiSet` vẫn hoạt động y hệt cũ; thêm assert
  `runtimeClientState.set` được gọi kèm theo (spy), KHÔNG chặn action gốc
  (test bằng cách làm RPC `runtimeClientState.set` reject, xác nhận action
  gốc vẫn hoàn thành bình thường).
- `runtime-status.ts`: `mergeById` không mất server nào từ danh sách local
  khi merge với danh sách remote; xử lý đúng khi remote có server đã xoá ở
  local (theo policy đã ghi trong solution — chưa quyết định chi tiết,
  viết test theo policy tạm: remote không ghi đè xoá của local, chỉ bổ
  sung server có trong remote mà local chưa có).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/store/slices/ui.test.ts src/renderer/src/store/slices/runtime-status.test.ts
```

## gitnexus

`impact({target: "uiSet", direction: "upstream"})` — `uiSet` khả năng có
rất nhiều caller (theo TDD, `ui.ts` là 1 trong các slice lớn nhất) — xác
nhận thêm 1 lời gọi song song không đổi hành vi bất kỳ caller nào trước
khi sửa.

## Blocking

Không.
