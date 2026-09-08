# FE-SOL-STORAGE-002: Zustand `persist` middleware với `StateStorage` backend-go

> **🔲 Designed — chưa implement.** Phụ thuộc
> [FE-SOL-STORAGE-001](./FE-SOL-STORAGE-001-local-app-hybrid-rpc-clients.md)
> và [FE-SOL-STORAGE-003](./FE-SOL-STORAGE-003-full-settings-sync.md) đã có
> RPC thật để adapter gọi vào — **làm sau cùng** trong nhóm CR này (xem
> [README](./README.md)'s thứ tự thực thi).

**CR:** [CR-STORAGE-002](../../../../../../docs/crs/v3/storage/CR-STORAGE-002-zustand-persist-middleware-backend-go.md)
**TDD tham chiếu:** [`specs/frontend/tdd/v5/02-state-management.md`](../../../../tdd/v5/02-state-management.md) §3 (Slice Pattern)

---

## 1. `StateStorage` adapter — không dùng `localStorage`

Zustand's `persist` middleware nhận bất kỳ implementation `StateStorage`
nào (`{getItem, setItem, removeItem}`, hỗ trợ async). Thay vì
`createJSONStorage(() => localStorage)` (cách dùng phổ biến nhất, và cũng
là cách **không** dùng ở đây theo đúng yêu cầu CR), viết 1 adapter gọi
`runtimeClientState`
([FE-SOL-STORAGE-001](./FE-SOL-STORAGE-001-local-app-hybrid-rpc-clients.md))
hoặc tương đương cho `settings`/`workspaceSession`:

```ts
// frontend/src/renderer/src/store/backend-go-storage.ts (MỚI)
import type { StateStorage } from 'zustand/middleware'
import { runtimeClientState, type ClientStateKind } from '../runtime/runtime-client-state-client'
import { usePersistenceStatusStore } from './slices/persistence-status'

export function createBackendGoStorage(kind: ClientStateKind): StateStorage {
  return {
    getItem: async (_name) => {
      const value = await runtimeClientState.get<unknown>(kind)
      return value === null ? null : JSON.stringify(value)
    },
    setItem: async (_name, value) => {
      await withRetryAndErrorStatus(kind, () => runtimeClientState.set(kind, JSON.parse(value)))
    },
    removeItem: async (_name) => {
      await runtimeClientState.set(kind, null)
    }
  }
}
```

## 2. Retry + trạng thái lỗi hiển thị được — thay hành vi nuốt lỗi hiện tại

Theo đúng yêu cầu CR ("mọi thông tin phải sync và lỗi từ backend-go"), thêm
1 slice mới ghi nhận trạng thái đồng bộ theo `kind`, và 1 helper retry dùng
chung:

```ts
// frontend/src/renderer/src/store/slices/persistence-status.ts (MỚI)
export type PersistenceStatus = 'synced' | 'pending' | 'error'

export type PersistenceStatusSlice = {
  persistenceStatus: Record<string, { status: PersistenceStatus; lastError?: string }>
  setPersistenceStatus: (kind: string, status: PersistenceStatus, error?: string) => void
}

export const createPersistenceStatusSlice: StateCreator<AppState, [], [], PersistenceStatusSlice> = (set) => ({
  persistenceStatus: {},
  setPersistenceStatus: (kind, status, error) => set(state => ({
    persistenceStatus: { ...state.persistenceStatus, [kind]: { status, lastError: error } }
  }))
})
```

```ts
// frontend/src/renderer/src/store/backend-go-storage.ts — tiếp tục
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

async function withRetryAndErrorStatus(kind: string, write: () => Promise<void>): Promise<void> {
  useAppStore.getState().setPersistenceStatus(kind, 'pending')
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await write()
      useAppStore.getState().setPersistenceStatus(kind, 'synced')
      return
    } catch (err) {
      if (attempt === RETRY_DELAYS_MS.length) {
        useAppStore.getState().setPersistenceStatus(kind, 'error', String(err))
        return   // KHÔNG throw lại — persist middleware không có chỗ nhận lỗi async có ý nghĩa
      }
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }
}
```

**Khác hẳn hành vi hiện tại của `ui.set` trên web** ("a failure is silently
swallowed", `web-preload-api.ts:2672-2674`) — UI có thể subscribe
`persistenceStatus[kind]` để hiện banner "chưa lưu được thay đổi", đúng yêu
cầu CR.

## 3. Hàng đợi 1-phần-tử-mới-nhất — tái dùng ý tưởng đã có, không viết lại

`persist` middleware tự nó không hàng đợi write chồng chéo — nếu `setItem`
đang chạy (đang retry) mà state đổi tiếp, `persist` middleware **gọi
`setItem` mới song song**, có thể ra kết quả sai thứ tự. Áp dụng đúng ý
tưởng `enqueuePersist`/`persistQueueByWorktree`
(`diffComments.ts:145-171` — "chỉ giữ write mới nhất, huỷ bỏ ý định ghi các
write cũ hơn còn đang chờ", không phải hủy request đang bay mà là bỏ qua
kết quả của nó khi 1 write mới hơn đã bắt đầu):

```ts
const pendingByKind = new Map<string, Promise<void>>()

function enqueueWrite(kind: string, write: () => Promise<void>): Promise<void> {
  const run = async () => { await write() }
  const chained = (pendingByKind.get(kind) ?? Promise.resolve()).then(run, run)
  pendingByKind.set(kind, chained)
  return chained
}
```

## 4. Áp dụng `persist` theo từng slice — KHÔNG bọc toàn bộ `AppState`

```ts
// frontend/src/renderer/src/store/slices/keybindings.ts — ví dụ
import { persist } from 'zustand/middleware'
import { createBackendGoStorage } from '../backend-go-storage'

export const createKeybindingsSlice: StateCreator<AppState, [], [], KeybindingsSlice> =
  persist(
    (set, get) => ({
      keybindings: getDefaultKeybindings(),
      setAction: (actionId, binding) => set(state => ({
        keybindings: { ...state.keybindings, [actionId]: binding }
      })),
      // ... actions khác
    }),
    {
      name: 'keybindings',   // key logic — KHÔNG map vào localStorage key nào
      storage: createBackendGoStorage('keybindings'),
      // partialize để không bọc field runtime-only (nếu slice có thêm state UI-only)
    }
  )
```

Chỉ áp dụng cho các slice đã có RPC thật từ
[FE-SOL-STORAGE-001](./FE-SOL-STORAGE-001-local-app-hybrid-rpc-clients.md)
(`keybindings`) và
[FE-SOL-STORAGE-003](./FE-SOL-STORAGE-003-full-settings-sync.md)
(`settings`) trong lần đầu triển khai — **không** áp dụng cho slice nhóm
"in-memory only" (`tabs`, `task`, `git-panel`, `workflow`, ...) trong
solution này, theo đúng "Không thuộc phạm vi" của CR-STORAGE-002.

## 5. `onRehydrateStorage` — thay thế logic load thủ công hiện có

`keybindings.ts`'s `loadKeybindings()` thủ công (xem FE-SOL-STORAGE-001)
có thể **thay bằng** `persist`'s `onRehydrateStorage` hook một khi slice đã
bọc `persist` — nhưng **chỉ cho nhánh `target.kind === 'environment'`**;
nhánh desktop-local (`window.api.keybindings.get()`) vẫn cần code riêng vì
đó không đi qua `createBackendGoStorage`. Vì vậy solution này **không xoá**
`loadKeybindings()` — chỉ đổi phần thân của nó để gọi `useKeybindingsStore.persist.rehydrate()`
khi ở nhánh remote, giữ nguyên nhánh local.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/store/backend-go-storage.ts` | TẠO MỚI |
| `frontend/src/renderer/src/store/slices/persistence-status.ts` | TẠO MỚI |
| `frontend/src/renderer/src/store/types.ts` | MODIFY — thêm `PersistenceStatusSlice` vào `AppState` |
| `frontend/src/renderer/src/store/slices/keybindings.ts` | MODIFY — bọc `persist`, nhánh remote |
| `frontend/src/renderer/src/store/slices/settings.ts` | MODIFY — bọc `persist` sau khi FE-SOL-STORAGE-003 xong |
| 1 component UI mới (ví dụ `PersistenceStatusBanner.tsx`) | TẠO MỚI — hiển thị `persistenceStatus[kind] === 'error'` |

## Rủi ro / Cần xác nhận trước khi implement

| Hạng mục | Ghi chú |
|---|---|
| Version Zustand hiện dùng trong `package.json` | Xác nhận hỗ trợ `persist` với `storage` async tuỳ biến + `partialize` trước khi áp dụng |
| Đổi UX "ghi ngay lập tức" của 1 số action (`keybindings.setAction`) | `persist` middleware không debounce mặc định — cần đo lại độ trễ cảm nhận, không giả định "giống hệt trước" |
| `onRehydrateStorage` chạy async, component có thể render trước khi rehydrate xong | Cần loading state riêng cho lần đầu mount, tương tự cách `ui.get()`/`settings.getSync()` xử lý pre-hydration hiện tại (`getSync` đồng bộ) — `persist`'s rehydrate luôn async, không có `getSync` tương đương |

## Không thuộc phạm vi solution này

- Quyết định slice "in-memory only" nào nên bọc `persist` — quyết định sản
  phẩm riêng, không nằm trong CR-STORAGE-002 (xem CR's "Không thuộc phạm
  vi").
- Transport push/realtime đa tab — không thiết kế ở đây (xem
  [README](../../../../../../docs/crs/v3/storage/README.md)'s nguyên tắc
  chung #3).

## Liên quan

- `frontend/src/renderer/src/store/slices/diffComments.ts:145-171` (mẫu hàng đợi tham chiếu)
- `frontend/src/renderer/src/web/web-preload-api.ts:2672-2674` (hành vi nuốt lỗi cần thay thế)
- [FE-SOL-STORAGE-001](./FE-SOL-STORAGE-001-local-app-hybrid-rpc-clients.md), [FE-SOL-STORAGE-003](./FE-SOL-STORAGE-003-full-settings-sync.md)
