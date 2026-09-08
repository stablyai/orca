# FE-SOL-STORAGE-003: Đồng bộ toàn bộ `GlobalSettings` qua `clientState.*` (kind `settings`)

> **🔲 Designed — chưa implement.** Phụ thuộc
> [BE-SOL-STORAGE-001](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
> (`ClientStateKind.CLIENT_STATE_KIND_SETTINGS` → cột `client_settings_json`).

**CR:** [CR-STORAGE-003](../../../../../../docs/crs/v3/storage/CR-STORAGE-003-full-settings-sync-per-user.md)
**TDD tham chiếu:** [`specs/frontend/tdd/v5/06-web-client.md`](../../../../tdd/v5/06-web-client.md)

---

## 1. Thay đổi cốt lõi — bỏ allowlist 5-field, KHÔNG đổi shape RPC cũ

`getRuntimeBackedStoredSettings()`/`syncRuntimeBackedSettings()`
(`frontend/src/renderer/src/web/web-preload-api.ts:3598-3678`) hiện hand-pick
5 field để gọi RPC `settings.get`/`settings.update` cũ (17-field Pick phía
backend). Theo đúng "Kế hoạch chuyển đổi không breaking" đã chốt ở
CR-STORAGE-003, **giữ nguyên** 2 hàm này và RPC `settings.get`/
`settings.update` — chúng tiếp tục phục vụ đúng mục đích hẹp ban đầu (các
field cross-host operational default). Thêm 2 hàm **mới**, song song:

```ts
// frontend/src/renderer/src/web/web-preload-api.ts — THÊM MỚI, không sửa hàm cũ
async function getFullClientSettings(): Promise<GlobalSettings | null> {
  return runtimeClientState.get<GlobalSettings>('settings')
}

async function syncFullClientSettings(next: GlobalSettings): Promise<void> {
  await runtimeClientState.set('settings', next)
}
```

## 2. `settings.set` — gọi cả 2 đường trong giai đoạn chuyển tiếp

```ts
// web-preload-api.ts:601-614 — settings.set(updates) — MODIFY
settings: {
  // ...
  set: async (updates) => {
    const next = mergeSettings(getStoredSettings(), updates, {})
    writeJson(SETTINGS_STORAGE_KEY, next)              // KHÔNG ĐỔI — vẫn optimistic-local trước
    await syncRuntimeBackedSettings(updates, next)      // KHÔNG ĐỔI — 5-field cũ, cross-host default
    await syncFullClientSettings(next)                  // MỚI — toàn bộ GlobalSettings lên backend-go
  }
}
```

`syncFullClientSettings` chạy **sau, không chặn `syncRuntimeBackedSettings`**
— nếu 1 trong 2 lỗi, cái còn lại vẫn nên chạy (2 đích lưu độc lập, không
transaction chung). Dùng `Promise.allSettled` thay vì `await` tuần tự nếu
cần cả 2 chạy song song:

```ts
set: async (updates) => {
  const next = mergeSettings(getStoredSettings(), updates, {})
  writeJson(SETTINGS_STORAGE_KEY, next)
  const [oldResult, fullResult] = await Promise.allSettled([
    syncRuntimeBackedSettings(updates, next),
    syncFullClientSettings(next)
  ])
  if (fullResult.status === 'rejected') {
    useAppStore.getState().setPersistenceStatus('settings', 'error', String(fullResult.reason))
  }
}
```

(`setPersistenceStatus` từ
[FE-SOL-STORAGE-002](./FE-SOL-STORAGE-002-zustand-persist-backend-storage.md)
— nếu solution đó chưa triển khai, tạm thời log lỗi ra console thay vì
nuốt âm thầm, KHÔNG lặp lại hành vi cũ.)

## 3. `settings.get` — ưu tiên bản đầy đủ từ backend-go khi có

```ts
// web-preload-api.ts:597 — settings.get() — MODIFY
get: async () => {
  const full = await getFullClientSettings()
  if (full !== null) {
    writeJson(SETTINGS_STORAGE_KEY, full)   // đồng bộ ngược lại localStorage cache
    return full
  }
  // Chưa có bản ghi backend-go (user cũ trước khi rollout) — fallback + seed
  return getRuntimeBackedStoredSettings()   // hành vi cũ, rồi CR-STORAGE-003's seed logic (mục 4) chạy
}
```

## 4. Seed dữ liệu cũ — 1 lần duy nhất, tránh reset preference hiện có

Theo đúng kế hoạch trong CR-STORAGE-003:

```ts
async function ensureFullSettingsSeeded(): Promise<GlobalSettings> {
  const remote = await getFullClientSettings()
  if (remote !== null) return remote
  const local = getStoredSettings()   // hàm sync hiện có, đọc localStorage
  await syncFullClientSettings(local)  // seed 1 lần
  return local
}
```

Gọi `ensureFullSettingsSeeded()` tại điểm khởi động app (nơi `settings.get`
đang được gọi lần đầu, ví dụ trong bootstrap flow) — **không** gọi trong
mọi lần `settings.get()` để tránh ghi lặp lại không cần thiết.

## 5. `settings.getSync` — KHÔNG đổi

`settings.getSync` (`web-preload-api.ts:598-600`) phục vụ pre-hydration
đồng bộ, không có RPC nào là đồng bộ — **giữ nguyên hoàn toàn**, tiếp tục
đọc `localStorage` trực tiếp. `localStorage` vẫn đóng vai trò cache cho
đường đọc nhanh này, kể cả sau CR-STORAGE-003 (backend-go giờ là nguồn
thật, `localStorage` là cache được đồng bộ lại ở bước 3 mỗi khi
`settings.get()` chạy).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/web/web-preload-api.ts` | MODIFY — thêm `getFullClientSettings`/`syncFullClientSettings`, sửa `settings.get`/`settings.set`, thêm `ensureFullSettingsSeeded` |
| `frontend/src/renderer/src/web/web-preload-api.test.ts` | MODIFY — test case cho seed, cho 2-đường-song-song, cho `settings.get` ưu tiên bản đầy đủ |

## Rủi ro / Cần xác nhận trước khi implement (nhắc lại từ CR, cụ thể hoá ở mức code)

| Hạng mục | Ghi chú |
|---|---|
| **Security review `vapidKeys`/`webPushSubscriptions`/`codexManagedAccounts`/`claudeManagedAccounts`** | **Bắt buộc trước khi implement bước 1** — nếu security review xác nhận có secret, cần loại field đó khỏi `next` trước khi gọi `syncFullClientSettings` (ví dụ 1 hàm `stripSecretFields(settings)` mới), KHÔNG gửi nguyên `GlobalSettings` object |
| 2 đường ghi độc lập có thể lệch dữ liệu | 5 field cũ (`settings.update`) và toàn bộ field mới (`clientState.set`) là 2 bản ghi khác nhau ở backend-go — cần xác nhận không có UI nào đọc nhầm từ đường cũ sau khi CR-STORAGE-003 triển khai (audit lại mọi nơi gọi `getRuntimeBackedStoredSettings()` trực tiếp) |
| Kích thước payload mỗi lần `settings.set` | Gửi toàn bộ `GlobalSettings` (không chỉ phần đổi) mỗi lần set — chấp nhận được vì tần suất set thấp (người dùng đổi 1 setting), nhưng cần đo thực tế nếu `terminalCustomThemes` lớn |

## Không thuộc phạm vi solution này

- Đồng bộ `GlobalSettings` cho desktop build — chỉ áp dụng nhánh web
  (`web-preload-api.ts`), theo đúng phạm vi CR-STORAGE-003.
- Zustand `persist` middleware hoá `settings.ts` — xem
  [FE-SOL-STORAGE-002](./FE-SOL-STORAGE-002-zustand-persist-backend-storage.md),
  có thể áp dụng SAU khi solution này có RPC `clientState.get/set(kind:
  'settings')` chạy thật, thay thế dần các hàm thủ công ở đây bằng
  `persist` middleware.

## Liên quan

- `specs/frontend/storage/ui-settings-session-hybrid.md` (phân tích gap gốc)
- `frontend/src/renderer/src/web/web-preload-api.ts:3598-3678`
- [BE-SOL-STORAGE-001](../../../../backend-go/crs/v3/storage/solutions/BE-SOL-STORAGE-001-user-profile-json-columns.md)
