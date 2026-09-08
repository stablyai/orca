# FE-TASK-STORAGE-008: `orca.web.workspaceSession.v1` — debounce + RPC + hydrate fallback

**Solution:** FE-SOL-STORAGE-004 | **CR:** CR-STORAGE-004(a)
**Depends on:** [TASK-BE-STORAGE-004](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-004-wscompat-client-state-channels.md) (backend-go)
**Status:** ✅ DONE (2026-09-08)

**Kết quả thực tế:** Đúng như kế hoạch — `frontend/src/renderer/src/lib/
debounce.ts` mới (không có helper `wait`+`maxWait` phù hợp có sẵn, đã kiểm tra
`lib/` và `runtime/` trước khi tạo). `flushWorkspaceSessionRemote`
(debounce 1s/5s-max-wait) gọi từ `session.set`/`session.patch`;
`session.setSync` không gọi RPC (xác nhận bằng test). `getStoredWorkspaceSession`
thêm fallback trả default + `hydrateWorkspaceSessionFromRemote` nền khi
localStorage trống. **Quyết định đã chốt cho "báo lại store sau hydrate"**
(rủi ro nêu trong task/solution): dispatch `CustomEvent('orca:workspaceSessionHydrated')`
trên `window` — không có channel `PreloadApi` sẵn có cho việc này (khác
`remoteWorkspace.onChanged`) và thêm 1 channel mới cần sửa `preload/api-types.ts`,
ngoài phạm vi file cho phép của lần triển khai này. Đây là 1 hook, CHƯA có
listener phía store — cần 1 task follow-up để wire UI re-render thật sau
hydrate. 4 test case (debounce collapse, setSync không gọi RPC, maxWait vẫn
flush, hydrate fallback) đều pass. `vitest run`: **84 passed, 1 pre-existing
failure không liên quan** (xem FE-TASK-STORAGE-006).

---

## Mục tiêu

Thêm nhánh backend-go song song cho `window.api.session` trên web, debounce
1s/5s-max-wait để tránh ngập RPC từ `session.patch` tần suất cao.

## Files cần sửa

1. `frontend/src/renderer/src/web/web-preload-api.ts` (MODIFY — `session` field)
2. `frontend/src/renderer/src/lib/debounce.ts` (MỚI, nếu chưa có helper phù hợp — kiểm tra trước, không tạo trùng)
3. `frontend/src/renderer/src/web/web-preload-api.test.ts` (MODIFY)

## Nội dung (xem FE-SOL-STORAGE-004 mục (a) cho code đầy đủ)

`session.set`/`session.patch` giữ nguyên ghi `localStorage` trước, thêm
`void flushWorkspaceSessionRemote(hostId)` (debounced) gọi
`workspaceSession.set` RPC. `session.setSync` **KHÔNG** gọi RPC (dùng cho
`beforeunload`, không có thời gian chờ network). `getStoredWorkspaceSession()`
thêm fallback: khi localStorage trống, trả default ngay + kích hoạt
`hydrateWorkspaceSessionFromRemote(hostId)` chạy nền.

## Test cases cần cover

- `session.patch` gọi 5 lần liên tiếp trong 500ms → chỉ 1 lời gọi RPC thật
  sau debounce (dùng `vi.useFakeTimers()`).
- `session.setSync` KHÔNG bao giờ gọi RPC (assert spy không được gọi).
- `getStoredWorkspaceSession()` khi localStorage trống: trả
  `getDefaultWorkspaceSession()` ngay lập tức (không block/await), và gọi
  `hydrateWorkspaceSessionFromRemote` (spy) đúng 1 lần.
- Debounce có `maxWait: 5000` — patch liên tục không ngừng vẫn flush sau 5s
  (không bị trì hoãn vô hạn).

## Rủi ro cần xác nhận khi implement (từ solution, không bỏ qua)

Cơ chế báo lại store sau khi `hydrateWorkspaceSessionFromRemote` xong
**chưa thiết kế chi tiết** — quyết định cụ thể (event emitter nội bộ, hay
để UI tự gọi lại) khi implement task này, ghi rõ trong code comment lựa
chọn đã chốt.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/web/web-preload-api.test.ts
```

## gitnexus

`impact({target: "session", direction: "upstream"})` (namespace trong
`web-preload-api.ts`) trước khi sửa.

## Blocking

FE-TASK-STORAGE-015/016 (reconnect/logout) cần `workspaceSession` không bị
xoá nhầm — không phụ thuộc code, chỉ phụ thuộc dữ liệu tồn tại đúng chỗ.
