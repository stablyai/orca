# FE-SOL-STORAGE-001: Hybrid `window.api` + `clientState.*` RPC cho keybindings/UI-local/saved-server-list

> **🔲 Designed — chưa implement.** Phụ thuộc
> [BE-SOL-STORAGE-001](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
> đã có RPC `clientState.get`/`clientState.set` thật — implement solution
> này trước khi backend-go có RPC sẽ không có gì để gọi.

**CR:** [CR-STORAGE-001](../../../../../../docs/crs/v3/storage/CR-STORAGE-001-local-app-storage-to-backend-go.md)
**Depends on:** [BE-SOL-STORAGE-001](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
**TDD tham chiếu:** [`specs/frontend/tdd/v5/02-state-management.md`](../../../../tdd/v5/02-state-management.md) (slice pattern), [`specs/frontend/api/ipc-surface.md`](../../../../api/ipc-surface.md) (hybrid `window.api`/RPC pattern đã có tiền lệ)

---

## 1. Pattern tái sử dụng — không phát minh gì mới

`ipc-surface.md` đã ghi nhận pattern hybrid dùng cho `git`/`repos`/`ssh`/
`credentials` (ví dụ `runtime-git-client.ts`):

```ts
const target = getActiveRuntimeTarget(settings)
if (target.kind !== 'environment') {
  return window.api.git.status({ worktreePath })   // desktop-local, không đổi
}
return callRuntimeRpc(target, 'git.status', { worktree: toRuntimeWorktreeSelector(...) })
```

Solution này áp dụng **đúng pattern này**, không phải pattern mới, cho 3
namespace: `keybindings`, phần `ui` cần bền qua cài lại (không phải toàn
bộ `PersistedUIState` — chỉ phần CR-STORAGE-001 xác định), và
`runtimeEnvironments` (saved server list).

## 2. File mới: `runtime-client-state-client.ts`

```ts
// frontend/src/renderer/src/runtime/runtime-client-state-client.ts (MỚI)
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import type { RuntimeTarget } from './runtime-types'

export type ClientStateKind =
  | 'keybindings'
  | 'uiLocal'
  | 'savedRuntimeEnvironments'

async function getClientState<T>(kind: ClientStateKind): Promise<T | null> {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  const result = await callRuntimeRpc<{ found: boolean; stateJson?: string }>(
    target, 'clientState.get', { kind }
  )
  return result.found ? (JSON.parse(result.stateJson!) as T) : null
}

async function setClientState<T>(kind: ClientStateKind, state: T): Promise<void> {
  const target = getActiveRuntimeTarget(useAppStore.getState().settings)
  await callRuntimeRpc(target, 'clientState.set', { kind, stateJson: JSON.stringify(state) })
}

export const runtimeClientState = { get: getClientState, set: setClientState }
```

**Vì sao 1 file dùng chung cho cả 3 `kind`, không phải 3 file/3 wrapper
riêng** — cùng lý do backend-go tham số hoá bằng `enum ClientStateKind`
(xem BE-SOL-STORAGE-001 §5): thao tác giống hệt nhau (get/set nguyên khối
JSON), khác duy nhất là `kind` string và kiểu `T` phía TypeScript.

## 3. `keybindings.ts` — thêm nhánh remote

```ts
// frontend/src/renderer/src/store/slices/keybindings.ts — MODIFY
loadKeybindings: async () => {
  const target = getActiveRuntimeTarget(get().settings)
  if (target.kind !== 'environment') {
    const local = await window.api.keybindings.get()   // KHÔNG ĐỔI — vẫn source-of-truth cho desktop
    set({ keybindings: local })
    return
  }
  // MỚI — web/paired: đọc từ backend-go, fallback về default nếu chưa có
  const remote = await runtimeClientState.get<KeybindingsConfig>('keybindings')
  set({ keybindings: remote ?? getDefaultKeybindings() })
},

setAction: async (actionId, binding) => {
  set(state => ({ keybindings: { ...state.keybindings, [actionId]: binding } }))
  const target = getActiveRuntimeTarget(get().settings)
  if (target.kind !== 'environment') {
    await window.api.keybindings.setAction(actionId, binding)   // KHÔNG ĐỔI
    return
  }
  await runtimeClientState.set('keybindings', get().keybindings)   // MỚI
}
```

**Desktop hoàn toàn không đổi hành vi** — nhánh `window.api.keybindings.*`
giữ nguyên 100%, theo đúng "Không thuộc phạm vi" của CR-STORAGE-001 (desktop
tiếp tục local-first). Chỉ nhánh `target.kind === 'environment'` (web hoặc
desktop paired với 1 runtime environment) là mới.

## 4. `ui.ts` — chỉ phần "cần bền qua cài lại", KHÔNG phải toàn bộ `PersistedUIState`

**Quan trọng — tránh nhầm lẫn với `ui.get`/`ui.set` RPC đã tồn tại**: RPC
`ui.get`/`ui.set` (`client-ui.ts`) đã đồng bộ **toàn bộ** `PersistedUIState`
tới `backend/src/main/persistence.ts`'s `Store` — nhưng đó vẫn là file
JSON cục bộ trên máy chạy Electron main process (xem CR-STORAGE-001's
"Bối cảnh"). Cái CR-STORAGE-001 muốn thêm là 1 **bản sao thứ 2 ở
backend-go**, dùng để khôi phục khi đổi máy — không thay thế RPC `ui.*`
hiện có.

Đề xuất: `ui.ts`'s action nào gọi `uiSet(...)` (đã có, ví dụ
`ui.ts:2101`) **thêm 1 lời gọi song song, không chặn** tới
`runtimeClientState.set('uiLocal', persistedUIState)` — debounce theo cùng
nhịp gọi `uiSet` để tránh nhân đôi tần suất RPC:

```ts
// ui.ts — trong action đã gọi uiSet(...), THÊM (không thay thế):
uiSet(updates)
void runtimeClientState.set('uiLocal', get().toPersistedUIState())  // MỚI, fire-and-forget
```

`toPersistedUIState()` là 1 selector mới, trích đúng field
`PersistedUIState` hiện đang đi qua `uiSet` — không phải state mới.

## 5. `runtime-status.ts` — saved server list

```ts
// frontend/src/renderer/src/store/slices/runtime-status.ts — MODIFY
loadSavedRuntimeEnvironments: async () => {
  const target = getActiveRuntimeTarget(get().settings)
  const local = await window.api.runtimeEnvironments.list()   // KHÔNG ĐỔI
  set({ runtimeEnvironments: local })

  if (target.kind === 'environment') {
    // MỚI — merge thêm danh sách đã lưu ở backend-go (ví dụ user đổi máy)
    const remote = await runtimeClientState.get<RuntimeEnvironmentSummary[]>('savedRuntimeEnvironments')
    if (remote) {
      set(state => ({ runtimeEnvironments: mergeById(state.runtimeEnvironments, remote) }))
    }
  }
},

saveRuntimeEnvironment: async (env) => {
  await window.api.runtimeEnvironments.save(env)   // KHÔNG ĐỔI
  const target = getActiveRuntimeTarget(get().settings)
  if (target.kind === 'environment') {
    await runtimeClientState.set('savedRuntimeEnvironments', get().runtimeEnvironments)   // MỚI
  }
}
```

## 6. Seed dữ liệu cũ — chỉ chạy 1 lần, tránh mất dữ liệu hiện có

Theo đúng "Kế hoạch chuyển đổi không breaking" đã nêu ở CR-STORAGE-003
(áp dụng tương tự ở đây): lần đầu `loadKeybindings()`/tương đương gọi mà
`runtimeClientState.get(...)` trả `null` (chưa có bản ghi backend-go), gửi
kèm bản local hiện tại lên ngay trong cùng lượt load:

```ts
const remote = await runtimeClientState.get<KeybindingsConfig>('keybindings')
if (remote === null) {
  const local = await window.api.keybindings.get()
  await runtimeClientState.set('keybindings', local)   // seed 1 lần
  set({ keybindings: local })
} else {
  set({ keybindings: remote })
}
```

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/runtime/runtime-client-state-client.ts` | TẠO MỚI |
| `frontend/src/renderer/src/store/slices/keybindings.ts` | MODIFY — nhánh remote + seed |
| `frontend/src/renderer/src/store/slices/ui.ts` | MODIFY — gọi song song `runtimeClientState.set('uiLocal', ...)` |
| `frontend/src/renderer/src/store/slices/runtime-status.ts` | MODIFY — merge saved list |

## Rủi ro / Cần xác nhận trước khi implement

| Hạng mục | Ghi chú |
|---|---|
| `toPersistedUIState()` selector | Cần xác nhận đúng field nào trong `PersistedUIState` là "cần bền qua cài lại" — không phải toàn bộ 80 field (một số như `windowBounds` chỉ có ý nghĩa cho đúng 1 máy) |
| Tần suất gọi `uiSet` | `ui.ts`'s action gọi `uiSet` khá thường xuyên (mỗi lần đổi `collapsedGroups`, zoom...) — cần xác nhận thêm 1 RPC song song không tạo áp lực RPC không cần thiết; cân nhắc debounce riêng cho nhánh `runtimeClientState.set` |
| `mergeById` cho saved server list | Cần quyết định policy xung đột khi 1 server bị xoá ở máy A nhưng vẫn còn trong bản backend-go (do máy B chưa đồng bộ) — chưa thiết kế chi tiết ở đây |

## Không thuộc phạm vi solution này

- Đổi hành vi `window.api.keybindings.*`/`window.api.settings.*` trên
  desktop — giữ nguyên hoàn toàn.
- `client_settings_json`/`workspaceSession`/`accountsDevServer` — xem
  [FE-SOL-STORAGE-003](./FE-SOL-STORAGE-003-full-settings-sync.md),
  [FE-SOL-STORAGE-004](./FE-SOL-STORAGE-004-workspace-session-accounts-devserver-sync.md).
- Zustand `persist` middleware hoá các slice này — xem
  [FE-SOL-STORAGE-002](./FE-SOL-STORAGE-002-zustand-persist-backend-storage.md)
  (làm sau, dùng `runtimeClientState` làm 1 trong các `StateStorage`
  backend).

## Liên quan

- `specs/frontend/api/ipc-surface.md` (pattern hybrid tham chiếu)
- `frontend/src/renderer/src/runtime/runtime-git-client.ts` (ví dụ pattern cùng dạng đã chạy thật)
- `frontend/src/renderer/src/store/slices/keybindings.ts`, `ui.ts`, `runtime-status.ts`
- [BE-SOL-STORAGE-001](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
