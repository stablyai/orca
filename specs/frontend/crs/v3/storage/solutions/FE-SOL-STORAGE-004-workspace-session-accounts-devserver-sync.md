# FE-SOL-STORAGE-004: Backend hoá `workspaceSession` và `accountsDevServer` (không đổi `saved-instances`)

> **🔲 Designed — chưa implement.** Phụ thuộc
> [BE-SOL-STORAGE-001](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
> (`workspaceSession.*` RPC + `ClientStateKind.ACCOUNTS_DEV_SERVER_MAP`).

**CR:** [CR-STORAGE-004](../../../../../../docs/crs/v3/storage/CR-STORAGE-004-session-and-connection-keys-to-backend.md)
**TDD tham chiếu:** [`specs/frontend/tdd/v5/06-web-client.md`](../../../../tdd/v5/06-web-client.md)

---

## (a) `orca.web.workspaceSession.v1` — `session.patch` debounce + RPC mới

`window.api.session` trên web hiện thuần localStorage
(`web-preload-api.ts:653-674`). Thêm nhánh backend-go **song song**, debounce
theo đúng nhịp desktop's `orca-data.json` writer (1s trailing / 5s
max-wait, xem `ui-settings-session-hybrid.md`'s session section) để tránh
ngập RPC — `session.patch` được gọi mỗi lần đổi tab/layout.

```ts
// frontend/src/renderer/src/web/web-preload-api.ts — session field, MODIFY
import { debounce } from '../lib/debounce'   // hoặc lib tương đương đã có trong repo

const flushWorkspaceSessionRemote = debounce(
  async (hostId: string | undefined) => {
    const session = getStoredWorkspaceSession(hostId)
    await callRuntimeRpc(getActiveRuntimeTarget(), 'workspaceSession.set', {
      hostId: hostId ?? 'local',
      sessionJson: JSON.stringify(session)
    })
  },
  { wait: 1_000, maxWait: 5_000 }
)

session: {
  get: (hostId) => Promise.resolve(getStoredWorkspaceSession(hostId)),   // KHÔNG ĐỔI — vẫn đọc local trước (nhanh)
  set: async (session, hostId) => {
    writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))   // KHÔNG ĐỔI
    void flushWorkspaceSessionRemote(hostId)   // MỚI, không chặn
  },
  patch: async (patch, hostId) => {
    const merged = { ...getStoredWorkspaceSession(hostId), ...patch }
    writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(merged))   // KHÔNG ĐỔI
    void flushWorkspaceSessionRemote(hostId)   // MỚI
  },
  readTerminalScrollback: () => null,          // KHÔNG ĐỔI
  setSync: (session, hostId) => {
    writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))   // KHÔNG ĐỔI
    // KHÔNG gọi RPC ở đây — setSync dùng cho beforeunload, không có thời gian chờ network
  }
}
```

**Khôi phục khi localStorage trống (máy mới/xoá cache)** — `getStoredWorkspaceSession()`
(`web-preload-api.ts:3737-3759`) thêm 1 fallback:

```ts
function getStoredWorkspaceSession(hostId?: string): WorkspaceSessionState {
  const local = readJson(sessionStorageKeyForHost(hostId), null)
  if (local !== null) return applyExistingOverlayLogic(local)   // KHÔNG ĐỔI logic overlay hiện có
  // MỚI — localStorage trống: trả về default NGAY (không block render chờ RPC),
  // rồi kích hoạt 1 lần fetch nền để populate lại từ backend-go
  void hydrateWorkspaceSessionFromRemote(hostId)
  return getDefaultWorkspaceSession()
}

async function hydrateWorkspaceSessionFromRemote(hostId?: string): Promise<void> {
  const resp = await callRuntimeRpc<{ found: boolean; sessionJson?: string }>(
    getActiveRuntimeTarget(), 'workspaceSession.get', { hostId: hostId ?? 'local' }
  )
  if (resp.found) {
    writeJson(sessionStorageKeyForHost(hostId), JSON.parse(resp.sessionJson!))
    // Trigger 1 re-render/re-hydrate phía store — cơ chế cụ thể (event, hoặc gọi lại action mở lại tab)
    // cần thiết kế chi tiết hơn khi implement, xem "Rủi ro" bên dưới.
  }
}
```

## (b) `orca.accountsDevServer.<environmentId>` — RPC map nhỏ

```ts
// frontend/src/renderer/src/runtime/accounts-dev-server-connection.ts — MODIFY
export async function getDefaultDevServerForEnvironment(environmentId: string): Promise<string | null> {
  const local = localStorage.getItem(`orca.accountsDevServer.${environmentId}`)
  if (local) return local
  const map = await runtimeClientState.get<Record<string, string>>('accountsDevServerMap')
  return map?.[environmentId] ?? null
}

export async function setDefaultDevServerForEnvironment(environmentId: string, devServerId: string): Promise<void> {
  localStorage.setItem(`orca.accountsDevServer.${environmentId}`, devServerId)   // KHÔNG ĐỔI — vẫn nhanh, local trước
  const map = (await runtimeClientState.get<Record<string, string>>('accountsDevServerMap')) ?? {}
  await runtimeClientState.set('accountsDevServerMap', { ...map, [environmentId]: devServerId })
}
```

## (c) `orca.saved-instances` — KHÔNG thay đổi trong solution này

Theo đúng phân tích ràng buộc kiến trúc trong CR-STORAGE-004: giữ nguyên
`hooks/useSavedOrcaInstances.ts` hoàn toàn như hiện tại. Không có code nào
sửa ở đây cho mục (c).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/web/web-preload-api.ts` | MODIFY — debounce + RPC cho `session.set/patch`, fallback hydrate |
| `frontend/src/renderer/src/runtime/accounts-dev-server-connection.ts` | MODIFY — thêm nhánh RPC |
| `frontend/src/renderer/src/hooks/useSavedOrcaInstances.ts` | KHÔNG ĐỔI |

## Rủi ro / Cần xác nhận trước khi implement

| Hạng mục | Ghi chú |
|---|---|
| Re-render sau `hydrateWorkspaceSessionFromRemote` | Đây là điểm chưa thiết kế xong — `getStoredWorkspaceSession()` được gọi đồng bộ ở nhiều nơi; hydrate nền xong rồi cần 1 cơ chế báo lại store (event emitter nội bộ, hoặc để UI tự gọi lại `window.api.session.get()` sau 1 khoảng trễ) — cần quyết định cụ thể khi implement, không suy đoán trước |
| Debounce library | Cần xác nhận `frontend/src/renderer/src/lib/` đã có sẵn debounce helper phù hợp (nếu chưa, viết mới, không phải trọng tâm CR) |
| Race giữa `setSync` (beforeunload) và `flushWorkspaceSessionRemote` đang debounce dở | `setSync` không gọi RPC (chủ ý, tránh chặn unload) — nghĩa là thay đổi cuối cùng trước khi đóng tab có thể **không kịp** lên backend-go nếu debounce chưa fire; đây là 1 khoảng trễ chấp nhận được (đã có bản local đúng), nhưng cần ghi rõ trong code comment, không phải bug ẩn |

## Không thuộc phạm vi solution này

- `orca.saved-instances` — xem CR-STORAGE-004's phân tích, không thiết kế
  giải pháp backend hoá ở đây.
- Đồng bộ realtime `workspaceSession` giữa nhiều tab/thiết bị đang mở cùng
  lúc.
- Desktop's `orca-data.json` — không đổi, hành vi debounce hiện có ở đó
  giữ nguyên.

## Liên quan

- `frontend/src/renderer/src/web/web-preload-api.ts:653-674,3730-3759`
- `frontend/src/renderer/src/runtime/accounts-dev-server-connection.ts`
- [BE-SOL-STORAGE-001](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
