# FE-TASK-STORAGE-009: `orca.accountsDevServer.<id>` — RPC map backend-go

**Solution:** FE-SOL-STORAGE-004 | **CR:** CR-STORAGE-004(b)
**Depends on:** [TASK-BE-STORAGE-004](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-004-wscompat-client-state-channels.md) (backend-go)
**Status:** ✅ DONE (2026-09-08)

**Kết quả thực tế:** Đúng như kế hoạch — `getDefaultDevServerForEnvironment`/
`setDefaultDevServerForEnvironment` mới, dùng chung `storageKey()`/localStorage
key với `getPreferredAccountsDevServerId`/`setPreferredAccountsDevServerId`
hiện có (KHÔNG sửa 2 hàm sync cũ — `impact` xác nhận HIGH risk, 11 symbol
downstream qua `AccountsPane`). `runtime-client-state-client.ts` chưa tồn tại
khi bắt đầu nên đã tạo mới theo đúng contract FE-SOL-STORAGE-001 §2; agent sở
hữu FE-TASK-STORAGE-001 sau đó đã tự cập nhật file này sang pattern
accessor-registration (tránh circular import với store) — vẫn tương thích,
không cần đổi gì ở `accounts-dev-server-connection.ts`. `vitest run` trên
`accounts-dev-server-connection.test.ts`: **4/4 pass**.

---

## Mục tiêu

Thêm nhánh backend-go cho map `environmentId → devServerId`, giữ
`localStorage` làm đường đọc nhanh ưu tiên.

## Files cần sửa

1. `frontend/src/renderer/src/runtime/accounts-dev-server-connection.ts` (MODIFY)
2. Test file tương ứng

## Nội dung (xem FE-SOL-STORAGE-004 mục (b) cho code đầy đủ)

```ts
export async function getDefaultDevServerForEnvironment(environmentId: string): Promise<string | null> {
  const local = localStorage.getItem(`orca.accountsDevServer.${environmentId}`)
  if (local) return local
  const map = await runtimeClientState.get<Record<string, string>>('accountsDevServerMap')
  return map?.[environmentId] ?? null
}

export async function setDefaultDevServerForEnvironment(environmentId: string, devServerId: string): Promise<void> {
  localStorage.setItem(`orca.accountsDevServer.${environmentId}`, devServerId)
  const map = (await runtimeClientState.get<Record<string, string>>('accountsDevServerMap')) ?? {}
  await runtimeClientState.set('accountsDevServerMap', { ...map, [environmentId]: devServerId })
}
```

## Test cases cần cover

- `getDefaultDevServerForEnvironment` trả bản `localStorage` ngay nếu có,
  KHÔNG gọi RPC.
- `getDefaultDevServerForEnvironment` fallback đúng vào RPC khi
  `localStorage` không có key đó.
- `setDefaultDevServerForEnvironment` ghi cả `localStorage` VÀ merge đúng
  vào map RPC (không ghi đè mất entry khác trong map).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/runtime/accounts-dev-server-connection.test.ts
```

## gitnexus

`impact({target: "getDefaultDevServerForEnvironment", direction: "upstream"})`
trước khi sửa — xác nhận danh sách caller (Accounts picker UI) không giả
định hàm này đồng bộ (nó vốn đã async, nhưng xác nhận không caller nào
quên `await`).

## Blocking

Không.
