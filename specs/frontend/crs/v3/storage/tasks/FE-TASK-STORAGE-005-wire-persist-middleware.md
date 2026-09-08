# FE-TASK-STORAGE-005: Bọc `persist` middleware vào `keybindings.ts`/`settings.ts` + banner lỗi

**Solution:** FE-SOL-STORAGE-002 | **CR:** CR-STORAGE-002
**Depends on:** FE-TASK-STORAGE-004, FE-TASK-STORAGE-002, [FE-TASK-STORAGE-006/007](./FE-TASK-STORAGE-006-web-preload-full-settings-sync.md) (settings)
**Status:** ✅ DONE (2026-09-08) — `settings.ts` phần hoãn nay đã xong, xem cuối file

**Kết quả thực tế — `keybindings.ts` (DONE, kiến trúc khác pseudocode, có lý do):**

Thử bọc `persist(...)` đúng như pseudocode trước — **thất bại thật**, không phải giả định: zustand
`persist` ghi đè `api.setState` ở cấp TOÀN BỘ store khi 1 slice bị bọc được spread vào 1 combined
store 40 slice (`create<AppState>()((...a) => ({...createKeybindingsSlice(...a), ...}))`). Kết quả:
MỌI `set()` ở BẤT KỲ slice nào (kể cả không liên quan keybindings) cũng kích hoạt 1 lần
`storage.setItem` (=> 1 lần `clientState.set` RPC) — kể cả trên desktop-local, vi phạm thẳng yêu
cầu "desktop 100% window.api, 0 RPC clientState" của CR-STORAGE-001. Xác nhận bằng regression thật:
`npx vitest run` trên toàn bộ scope sau khi bọc `persist` → **55 test fail ở 14 file** hoàn toàn
không liên quan (ví dụ `RepositoryPane.test.ts` throw `setPersistenceStatus is not a function` từ
bên trong `store/index.ts`, vì `MockAppState` test helper không có field đó và store thật bị
`persist` "chiếm" `setState` toàn cục).

**Giải pháp áp dụng thay thế** — giữ đúng tinh thần CR-STORAGE-002 (retry + error-status thay silent
swallow) nhưng KHÔNG dùng `persist(...)` HOC quanh slice: `keybindings.ts`'s 2 nhánh remote
(`fetchKeybindings`, `setKeybindingOverride`/`resetKeybindingOverride`/`disableKeybindingAction`)
gọi thẳng `enqueueWrite`/`withRetryAndErrorStatus` (từ `backend-go-storage.ts`, FE-TASK-STORAGE-004)
ngay trong action của chính slice đó — vẫn 100% scoped vào riêng nhánh `target.kind === 'environment'`
của keybindings, không đụng `api.setState` toàn cục. Đã ghi lại phát hiện này vào
FE-TASK-STORAGE-004's "Kết quả thực tế" vì nó đổi cách `createBackendGoStorage` được dùng.

`PersistenceStatusBanner.tsx` implement đúng thiết kế (hiện khi bất kỳ `kind` nào
`status === 'error'`, dùng token `destructive`/`role="alert"` theo mẫu `ExternalFileChangeBanner.tsx`
đã có, không tự chế màu mới).

**🟡 PARTIAL — phần bị hoãn:** `settings.ts` KHÔNG được bọc/đổi trong task này. Lý do: `settings.ts`
hiện tại hoàn toàn dựa vào `window.api.settings.get/set` (RPC `settings.*` cũ, đồng bộ qua Electron
main's `persistence.ts` Store), CHƯA có nhánh hybrid `target.kind === 'environment'` nào dùng
`clientState` kind `'settings'` cả — khác với `keybindings.ts` (đã có nhánh remote từ
FE-TASK-STORAGE-002). `runtime-client-state-client.ts` NAY đã có kind `'settings'` (thêm bởi agent
khác đang làm FE-TASK-STORAGE-006/007), và `web-preload-api.ts` đã có 2 chỗ dùng nội bộ
`{kind: 'settings'}` — nhưng đó là phần triển khai RIÊNG của `web-preload-api.ts`'s CHÍNH NÓ khi giả
lập `window.api.settings.*` cho Web, KHÔNG phải `settings.ts`'s slice tự có nhánh hybrid như
`keybindings.ts`. Theo đúng điều kiện dừng trong yêu cầu task ("chỉ làm nếu FE-TASK-STORAGE-006/007
đã xong"), phần `settings.ts` bị hoãn — cần agent làm FE-TASK-STORAGE-006/007 xác nhận xong trước,
rồi áp dụng CÙNG kỹ thuật đã dùng cho `keybindings.ts` (gọi trực tiếp `enqueueWrite`/
`withRetryAndErrorStatus`, KHÔNG bọc `persist`).

`npx vitest run src/renderer/src/store/slices/keybindings.test.ts src/renderer/src/components/settings/PersistenceStatusBanner.test.tsx`:
**11/11 pass** (7 keybindings + 4 PersistenceStatusBanner). `settings.test.ts` không tồn tại/không
đổi (phần settings bị hoãn).

**Cập nhật 2026-09-08 — phần `settings.ts` hoàn tất:** FE-TASK-STORAGE-006/007
đã xong (xác nhận), unblock điều kiện dừng ở trên. Điểm khác so với dự kiến ban
đầu: **không phải `store/slices/settings.ts` cần sửa** — slice đó chỉ gọi
`window.api.settings.get/set` đồng nhất cho cả desktop/web (không có nhánh
`target.kind` như `keybindings.ts`). Nhánh hybrid thật sự nằm trong
`web/web-preload-api.ts`'s `settings.set` (phần web-build), nơi
`syncFullClientSettings(next)` trước đây chỉ `console.error` khi lỗi (với
comment tự ghi "chuyển sang setPersistenceStatus once that store exists" —
nay store đó (FE-TASK-STORAGE-004) đã tồn tại). Đã sửa: gọi qua
`enqueueWrite('settings', () => withRetryAndErrorStatus('settings', () =>
syncFullClientSettings(next)))`, `void` (fire-and-forget, không block
`settings.set()`'s caller trong lúc retry 2s/4s/8s) — đúng kỹ thuật đã dùng
cho `keybindings.ts`, không dùng `persist` HOC (lý do y hệt: tránh chiếm
`api.setState` toàn cục).

Test mới: `settings.set routes the full-settings sync through
enqueueWrite/withRetryAndErrorStatus, reporting a visible error status on
permanent failure` (`web-preload-api.test.ts`) — xác nhận `settings.set()`
KHÔNG block trong lúc retry, và `setPersistenceStatus('settings', 'error',
...)` được gọi sau 3 lần retry thất bại (thay vì chỉ `console.error` âm
thầm). Verify thật:
```
npx vitest run src/renderer/src/web/web-preload-api.test.ts
# → 81/82 pass (1 fail là lỗi có sẵn không liên quan: preload/gitlab.ts
#   không tồn tại trong bất kỳ commit nào của repo, xác nhận qua git log --all)
npx vitest run src/renderer/src/store/backend-go-storage.test.ts \
  src/renderer/src/store/slices/keybindings.test.ts \
  src/renderer/src/store/slices/settings.test.ts \
  src/renderer/src/components/settings/PersistenceStatusBanner.test.tsx
# → 4 file, 27/27 pass
npx tsc --noEmit -p tsconfig.json   # 0 lỗi type mới trên các dòng đã sửa
npx oxlint <các file đã sửa>         # sạch
```

---

## Mục tiêu

Áp dụng `persist` middleware **chỉ** cho 2 slice đã có RPC thật
(`keybindings`, `settings`) — KHÔNG áp dụng cho slice "in-memory only"
trong task này (ngoài phạm vi CR-STORAGE-002, xem solution).

## Files cần sửa

1. `frontend/src/renderer/src/store/slices/keybindings.ts` (MODIFY — bọc `persist`)
2. `frontend/src/renderer/src/store/slices/settings.ts` (MODIFY — bọc `persist`, chỉ sau khi FE-SOL-STORAGE-003 có RPC `clientState` kind `settings`)
3. `frontend/src/renderer/src/components/settings/PersistenceStatusBanner.tsx` (MỚI)
4. Test file tương ứng

## Nội dung (xem FE-SOL-STORAGE-002 §4-§5)

```ts
export const createKeybindingsSlice: StateCreator<AppState, [], [], KeybindingsSlice> = persist(
  (set, get) => ({ /* ...actions hiện có... */ }),
  { name: 'keybindings', storage: createBackendGoStorage('keybindings') }
)
```

`loadKeybindings()`'s nhánh remote (từ FE-TASK-STORAGE-002) đổi thành gọi
`useKeybindingsStore.persist.rehydrate()` — **giữ nguyên** nhánh desktop-local
(`window.api.keybindings.get()`), chỉ nhánh remote đổi sang cơ chế
`persist`.

`PersistenceStatusBanner.tsx` — subscribe `persistenceStatus`, hiện banner
khi bất kỳ `kind` nào ở trạng thái `'error'`, theo `docs/STYLEGUIDE.md`'s
component/token quy ước (không tự chế màu sắc/spacing mới).

## Test cases cần cover

- Rehydrate từ `createBackendGoStorage('keybindings')` khi mount — mock
  `runtimeClientState.get` trả dữ liệu, xác nhận state sau rehydrate đúng.
- `PersistenceStatusBanner` hiện khi `persistenceStatus.keybindings.status
  === 'error'`, ẩn khi `'synced'`/`'pending'`.
- Desktop nhánh local — xác nhận KHÔNG bị ảnh hưởng bởi việc bọc `persist`
  (persist chỉ áp dụng khi `storage` được đọc, nhánh desktop không đi qua
  `createBackendGoStorage`).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/store/slices/keybindings.test.ts src/renderer/src/store/slices/settings.test.ts src/renderer/src/components/settings/PersistenceStatusBanner.test.tsx
```

## gitnexus

`impact({target: "createKeybindingsSlice", direction: "upstream"})` và
tương đương cho `createSettingsSlice` — bọc `persist` đổi kiểu trả về của
`StateCreator`, xác nhận `store/index.ts`'s cách compose slice
(`...createKeybindingsSlice(...a)`) vẫn tương thích type-wise.

## Blocking

Không.
