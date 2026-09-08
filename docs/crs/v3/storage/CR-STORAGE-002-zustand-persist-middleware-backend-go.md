# CR-STORAGE-002 — Zustand `persist` middleware với backend-go làm storage, có xử lý lỗi

| Trường | Giá trị |
|--------|---------|
| **CR ID** | CR-STORAGE-002 |
| **Tên** | Chuẩn hoá persistence của store Zustand qua 1 `persist` middleware dùng chung, backend là `backend-go` (không phải `localStorage`) |
| **Loại** | Architectural Change / Infra |
| **Priority** | P1 |
| **Phiên bản** | v1.0 |
| **Ngày tạo** | 2026-09-07 |
| **Trạng thái** | 🔲 Proposed — chưa triển khai |
| **Tác giả** | Yêu cầu user: "Store Zustand phải hỗ trợ persist middleware và mọi thông tin phải sync và lỗi từ backend-go" |
| **Tác động HLD** | Frontend store architecture (`store/index.ts`, `store/types.ts`) |
| **Tác động Features** | Toàn bộ slice hiện phân loại "Backend RPC-persisted" hoặc "In-memory only" trong `feature-persistence-matrix.md` |

---

## Bối cảnh & Vấn đề gốc

Xác nhận từ [`specs/frontend/storage/README.md`](../../../../specs/frontend/storage/README.md#the-single-most-important-fact-the-zustand-store-itself-persists-nothing)
và [`feature-persistence-matrix.md`](../../../../specs/frontend/storage/feature-persistence-matrix.md):
`frontend/src/renderer/src/store/index.ts` **không dùng** Zustand `persist`/
`createJSONStorage` middleware ở bất kỳ đâu — mỗi slice tự cài đặt riêng lẻ
việc gọi `window.api.*`/`callRuntimeRpc(...)` **thủ công** trong action
handler của nó. Hệ quả đã ghi nhận:

1. **Không nhất quán**: một số slice gọi RPC sau mỗi hành động
   (`worktrees.ts`, `diffComments.ts`), một số khác **quên gọi hoàn toàn**
   — `tabs.ts`, `workflow.ts`, `task.ts`, `git-panel.ts`, `dev-servers.ts`,
   `ssh.ts`, `ai-provider-slice.ts`, `profile-slice.ts` có **0** lời gọi
   persistence trong toàn bộ file (xác nhận bằng grep `callRuntimeRpc`/
   `window.api` — 0 kết quả).
2. **Không có xử lý lỗi thống nhất**: mỗi call site tự quyết định retry
   hay không. Ví dụ `ui.set` trên web nuốt lỗi RPC âm thầm ("a failure is
   silently swallowed", `web-preload-api.ts:2672-2674`) — người dùng không
   bao giờ biết thay đổi của họ không đến được backend.
3. **Không có hàng đợi offline chung** — mỗi cơ chế tự chế lại
   optimistic-write-then-reconcile (`mergeWebUIState`, `mergeSettings`) —
   trùng lặp logic, dễ lệch hành vi giữa các namespace (đã thấy: `ui` có
   full-object sync, `settings` chỉ sync 5/200 field — 2 hành vi khác hẳn
   nhau cho cùng 1 pattern).

## Giải pháp đề xuất

### 1. Một `StateStorage` adapter dùng chung, không phải `localStorage`

Zustand's `persist` middleware nhận bất kỳ implementation nào của interface
`StateStorage` (`{getItem, setItem, removeItem}` — có thể async). Đề xuất
viết 1 adapter mới, `frontend/src/renderer/src/store/backend-go-storage.ts`,
implement `StateStorage` bằng cách gọi `callRuntimeRpc(target, '<namespace>.get'
| '<namespace>.set', ...)` — các RPC method mới do
[CR-STORAGE-001](./CR-STORAGE-001-local-app-storage-to-backend-go.md)/
[CR-STORAGE-003](./CR-STORAGE-003-full-settings-sync-per-user.md)/
[CR-STORAGE-004](./CR-STORAGE-004-session-and-connection-keys-to-backend.md)
định nghĩa — **không phải** `window.localStorage.getItem/setItem`.

```ts
// Phác thảo — mỗi "key" Zustand persist truyền vào map 1-1 với 1 RPC namespace
function createBackendGoStorage(namespace: string): StateStorage {
  return {
    getItem: async () => {
      const result = await callRuntimeRpc(getActiveRuntimeTarget(), `${namespace}.get`, {})
      return result ? JSON.stringify(result) : null
    },
    setItem: async (_key, value) => {
      await callRuntimeRpc(getActiveRuntimeTarget(), `${namespace}.set`, JSON.parse(value))
    },
    removeItem: async () => {
      await callRuntimeRpc(getActiveRuntimeTarget(), `${namespace}.clear`, {})
    }
  }
}
```

### 2. Áp dụng `persist` theo từng slice, không phải 1 `persist` bọc toàn bộ `AppState`

`AppState` gộp ~50 slice khác nhau, thuộc nhiều tầng lưu trữ khác nhau
(backend RPC / local desktop-only / in-memory có chủ đích, ví dụ
`agent-status.ts` **đúng ý** là ephemeral). Bọc `persist` quanh **toàn bộ**
`AppState` sẽ:
- Cố gắng đồng bộ cả những state ephemeral có chủ đích (agent live-status,
  trace stream) — sai mục đích thiết kế của chúng.
- Tạo 1 payload khổng lồ mỗi lần ghi (toàn bộ `AppState`) thay vì ghi đúng
  phần thay đổi.

**Đề xuất**: mỗi slice cần bền (theo phân loại trong
`feature-persistence-matrix.md`) tự khai báo `persist` middleware riêng ở
mức tạo slice của nó (Zustand hỗ trợ nhiều `persist` độc lập trên các phần
state khác nhau qua `partialize`), namespace RPC ứng với đúng bảng/cột
backend-go đã định nghĩa ở CR-001/003/004. Slice thuộc nhóm "In-memory only"
(xem danh sách trong `feature-persistence-matrix.md`) **không** được bọc
`persist` trong CR này — đó là quyết định sản phẩm riêng (tabs/task/
git-panel có nên bền hay không), không lẫn vào 1 CR hạ tầng.

### 3. Xử lý lỗi hiển thị được, có retry — theo yêu cầu "sync và lỗi từ backend-go"

`persist` middleware hỗ trợ hook `onRehydrateStorage` (khi load) nhưng
**không có hook lỗi cho `setItem`** sẵn có — cần bọc thêm 1 lớp mỏng quanh
`createBackendGoStorage` để:

- Bắt lỗi RPC (timeout, mất kết nối, lỗi validate phía backend-go) và ghi
  vào 1 slice trạng thái chung mới, ví dụ `store/slices/persistence-status.ts`
  (`{ [namespace]: 'synced' | 'pending' | 'error', lastError?: string }`),
  để UI có thể hiển thị banner "chưa lưu được thay đổi" — **khác hẳn** hành
  vi nuốt lỗi âm thầm hiện tại của `ui.set` trên web.
- Retry theo backoff cố định (ví dụ 3 lần, 2s/4s/8s) trước khi chuyển
  namespace đó sang trạng thái `error` và dừng — tránh vòng lặp retry vô
  hạn làm ngập RPC khi backend-go thật sự down.
- Hàng đợi 1-phần-tử-mới-nhất theo namespace (giống hệt pattern
  `enqueuePersist`/`persistQueueByWorktree` đã có trong
  `diffComments.ts:145-171` — tái dùng ý tưởng "chỉ giữ write mới nhất, huỷ
  write cũ hơn đang chờ" thay vì tự nghĩ lại).

## Rủi ro / Phụ thuộc

| Hạng mục | Rủi ro | Ghi chú |
|---|---|---|
| Phụ thuộc cứng vào CR-STORAGE-001/003/004 có RPC thật | Cao nếu làm trước | Nếu triển khai CR này trước khi có RPC namespace mới, adapter không có gì để gọi — **phải làm sau cùng** (xem README's "Thứ tự thực thi") |
| Đổi hành vi ghi từ đồng bộ-ngay sang qua `persist` middleware (thường debounce) | Trung bình | Một số action hiện ghi ngay lập tức (ví dụ `keybindings.setAction` — người dùng mong đợi rebind có hiệu lực tức thì); `persist` middleware mặc định không debounce nhưng cần audit từng slice để không đổi UX cảm nhận |
| Zustand `persist` version cụ thể trong `package.json` | Thấp | Xác nhận version đang dùng hỗ trợ multi-instance `persist` + custom `StateStorage` async trước khi áp dụng (đa số version hiện đại đều hỗ trợ) |

## Không thuộc phạm vi CR này

- Quyết định slice nào trong nhóm "in-memory only" (`tabs.ts`, `task.ts`,
  `git-panel.ts`, `workflow.ts`, `dev-servers.ts`, `ssh.ts`,
  `ai-provider-slice.ts`, `profile-slice.ts`) **nên** trở thành bền hay
  không — đây là quyết định sản phẩm/UX, cần CR riêng cho từng slice sau
  khi hạ tầng `persist` middleware này tồn tại.
- Transport push/realtime giữa nhiều tab/thiết bị — như README chung đã
  nêu, không CR nào trong nhóm này xây transport push mới.
- Migrate `worktrees.ts`/`diffComments.ts`/`editor.ts` (đã persist đúng
  cách qua RPC theo-hành-động) sang `persist` middleware — các slice này
  **đã hoạt động đúng**, việc bọc thêm `persist` middleware không mang lại
  lợi ích rõ ràng và có rủi ro regression không cần thiết; để nguyên.

## Liên quan

- `specs/frontend/storage/README.md`, `feature-persistence-matrix.md`
- `frontend/src/renderer/src/store/index.ts`, `store/types.ts`
- `frontend/src/renderer/src/store/slices/diffComments.ts:145-171` (mẫu hàng đợi tham chiếu)
- `frontend/src/renderer/src/web/web-preload-api.ts:2672-2674` (hành vi nuốt lỗi cần thay thế)
- [CR-STORAGE-001](./CR-STORAGE-001-local-app-storage-to-backend-go.md), [CR-STORAGE-003](./CR-STORAGE-003-full-settings-sync-per-user.md), [CR-STORAGE-004](./CR-STORAGE-004-session-and-connection-keys-to-backend.md)
