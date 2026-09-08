# FE-TASK-STORAGE-001: Tạo `runtime-client-state-client.ts` (shared RPC wrapper)

**Solution:** FE-SOL-STORAGE-001 | **CR:** CR-STORAGE-001
**Depends on:** [TASK-BE-STORAGE-004](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-004-wscompat-client-state-channels.md) (backend-go)
**Status:** ✅ DONE (2026-09-07)

**Kết quả thực tế:** Đúng như thiết kế RPC contract (`clientState.get`/`set`), nhưng đổi 1 điểm so
với pseudocode gốc: `getClientState`/`setClientState` KHÔNG `import { useAppStore }` trực tiếp (sẽ
tạo circular import `store/index.ts` ↔ `runtime/runtime-client-state-client.ts` — xem tiền lệ lỗi
thật đã ghi trong `store/slices/dev-servers-selectors.ts`). Thay vào đó dùng
`registerClientStateSettingsAccessor()` — cùng kỹ thuật `registerHttpLinkStoreAccessor` đã có trong
`store/index.ts`. File cũng đã có sẵn 2 `ClientStateKind` khác (`settings`, `accountsDevServerMap`)
do agent khác (FE-TASK-STORAGE-006/009) thêm song song — giữ nguyên, gộp chung.

`npx vitest run src/renderer/src/runtime/runtime-client-state-client.test.ts`: **5/5 pass**.

---

## Mục tiêu

File client wrapper dùng chung cho mọi nhánh `clientState.get`/`clientState.set`
— nền tảng cho FE-TASK-STORAGE-002/003 và cả FE-SOL-STORAGE-002's
`persist` middleware sau này.

## Files cần sửa

1. `frontend/src/renderer/src/runtime/runtime-client-state-client.ts` (MỚI)
2. `frontend/src/renderer/src/runtime/runtime-client-state-client.test.ts` (MỚI)

## Nội dung (xem FE-SOL-STORAGE-001 §2 cho code đầy đủ)

```ts
export type ClientStateKind = 'keybindings' | 'uiLocal' | 'savedRuntimeEnvironments'

async function getClientState<T>(kind: ClientStateKind): Promise<T | null>
async function setClientState<T>(kind: ClientStateKind, state: T): Promise<void>

export const runtimeClientState = { get: getClientState, set: setClientState }
```

## Test cases cần cover

- `get()` trả `null` khi RPC trả `{found: false}`.
- `get()` parse đúng `stateJson` thành object khi `{found: true, stateJson: "..."}`.
- `set()` gọi `clientState.set` với đúng `{kind, stateJson: JSON.stringify(state)}`.
- `get()`/`set()` dùng đúng `getActiveRuntimeTarget()` hiện tại (mock store settings để test 2 case `target.kind`).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/runtime/runtime-client-state-client.test.ts
```

## gitnexus

Không áp dụng — file mới, chưa có caller nào. Chạy `impact()` khi các task
sau (002/003) bắt đầu import file này vào slice thật.

## Blocking

FE-TASK-STORAGE-002, FE-TASK-STORAGE-003 phụ thuộc file này.
