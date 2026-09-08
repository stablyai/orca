# FE-TASK-STORAGE-004: `backend-go-storage.ts` (`StateStorage` adapter) + `persistence-status.ts` slice

**Solution:** FE-SOL-STORAGE-002 | **CR:** CR-STORAGE-002
**Depends on:** FE-TASK-STORAGE-001
**Status:** ✅ DONE (2026-09-07)

**Kết quả thực tế:** `backend-go-storage.ts`/`persistence-status.ts` implement đúng thiết kế
(`withRetryAndErrorStatus` 3 lần retry 2s/4s/8s, `enqueueWrite` hàng đợi 1-mới-nhất mirror
`enqueuePersist` trong `diffComments.ts`, `createBackendGoStorage(kind)` trả `StateStorage` đúng
contract). Điểm khác so với pseudocode: `setPersistenceStatus` không gọi `useAppStore.getState()`
trực tiếp trong `backend-go-storage.ts` — cùng lý do circular-import như FE-TASK-STORAGE-001, dùng
`registerPersistenceStatusSetter()`, đăng ký 1 lần trong `store/index.ts`.

**Phát hiện quan trọng khi làm FE-TASK-STORAGE-005** (ghi lại ở đây vì ảnh hưởng trực tiếp cách
`createBackendGoStorage` được dùng): bọc zustand `persist` quanh 1 slice bên trong 1 combined store
~40 slice (`useAppStore`) là KHÔNG AN TOÀN — `persist` ghi đè `api.setState` ở cấp TOÀN BỘ store,
nên bất kỳ `set()` nào ở BẤT KỲ slice nào cũng kích hoạt `storage.setItem` của slice bị bọc, kể cả
trên desktop-local. Đã tái hiện bằng regression thật (55 test fail ở 14 file không liên quan khi
thử bọc `persist` quanh `createKeybindingsSlice`). Do đó `createBackendGoStorage`/
`withRetryAndErrorStatus`/`enqueueWrite` vẫn đúng như thiết kế và có test riêng, nhưng
FE-TASK-STORAGE-005 gọi các hàm này TRỰC TIẾP từ trong action của slice thay vì qua
`persist(...)` — xem comment `persistKeybindingsToBackendGo` trong `keybindings.ts`.

`npx vitest run src/renderer/src/store/backend-go-storage.test.ts src/renderer/src/store/slices/persistence-status.test.ts`:
**13/13 pass** (8 backend-go-storage + 5 persistence-status).

---

## Mục tiêu

Adapter `StateStorage` cho Zustand `persist` middleware, backend là
`runtimeClientState` (không `localStorage`), có retry/backoff + slice
trạng thái lỗi hiển thị được.

## Files cần sửa

1. `frontend/src/renderer/src/store/backend-go-storage.ts` (MỚI)
2. `frontend/src/renderer/src/store/slices/persistence-status.ts` (MỚI)
3. `frontend/src/renderer/src/store/types.ts` (MODIFY — thêm `PersistenceStatusSlice` vào `AppState`)
4. `frontend/src/renderer/src/store/index.ts` (MODIFY — đăng ký `createPersistenceStatusSlice`)
5. Test file cho cả 2 module mới

## Nội dung (xem FE-SOL-STORAGE-002 §1-§3 cho code đầy đủ)

- `createBackendGoStorage(kind)` — trả `StateStorage` gọi `runtimeClientState.get/set`.
- `withRetryAndErrorStatus(kind, write)` — retry 3 lần (2s/4s/8s), set
  `persistenceStatus[kind]` = `'pending'|'synced'|'error'`, KHÔNG throw lại
  sau khi hết retry (persist middleware không có chỗ nhận lỗi async có ý
  nghĩa).
- `enqueueWrite(kind, write)` — hàng đợi 1-phần-tử-mới-nhất, mirror
  `enqueuePersist` pattern trong `diffComments.ts:145-171`.

## Test cases cần cover

- `withRetryAndErrorStatus`: 3 lần fail liên tiếp → `persistenceStatus[kind]
  === 'error'`, KHÔNG throw ra ngoài.
- `withRetryAndErrorStatus`: fail 1 lần rồi thành công ở lần retry thứ 2 →
  `persistenceStatus[kind] === 'synced'`.
- `enqueueWrite`: 2 write gọi liên tiếp trước khi write 1 xong → cả 2 chạy
  tuần tự, không chạy song song (dùng `vi.useFakeTimers()`/promise ordering
  assertion).
- `createBackendGoStorage(kind).getItem`: trả `null` (string) khi
  `runtimeClientState.get` trả `null` — đúng contract `StateStorage`.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/store/backend-go-storage.test.ts src/renderer/src/store/slices/persistence-status.test.ts
```

## gitnexus

Không áp dụng cho phần code mới (chưa có caller). Chạy `impact({target:
"AppState"})` sau khi sửa `types.ts` — xác nhận thêm 1 slice vào union type
không phá build ở bất kỳ file nào dùng `AppState` trực tiếp (thường an
toàn vì đây là phép giao union thêm field, nhưng vẫn cần xác nhận theo quy
tắc bắt buộc).

## Blocking

FE-TASK-STORAGE-005 (wire `persist` vào slice thật) phụ thuộc file này.
