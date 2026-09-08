# FE-TASK-STORAGE-007: Seed dữ liệu `GlobalSettings` cũ — 1 lần duy nhất

**Solution:** FE-SOL-STORAGE-003 | **CR:** CR-STORAGE-003
**Depends on:** FE-TASK-STORAGE-006
**Status:** ✅ DONE (2026-09-08)

**Kết quả thực tế:** `ensureFullSettingsSeeded()` implement đúng như spec, gọi
từ nhánh fallback của `settings.get()` (fire-and-forget) — không có bootstrap
call site riêng để sửa (không nằm trong phạm vi file cho phép của lần triển
khai này), nên gọi tại chính điểm đầu tiên `settings.get()` phát hiện chưa có
bản ghi backend-go, tự nhiên chỉ seed 1 lần vì lần gọi kế tiếp
`getFullClientSettings()` đã thấy bản ghi. 3 test case cần thiết (seed đúng 1
lần khi miss, không ghi lại khi đã có bản ghi remote, gọi 2 lần liên tiếp
không ghi lặp) đều pass. `vitest run` trên `web-preload-api.test.ts`: **84
passed, 1 pre-existing failure không liên quan** (xem FE-TASK-STORAGE-006).

---

## Mục tiêu

Tránh reset preference hiện có của user về mặc định ngay sau rollout —
seed `client_settings_json` từ `localStorage` hiện tại lần đầu duy nhất.

## Files cần sửa

1. `frontend/src/renderer/src/web/web-preload-api.ts` (MODIFY — thêm `ensureFullSettingsSeeded`)
2. Nơi gọi bootstrap khởi động app (xác định qua `codegraph explore "settings.get bootstrap"`) — MODIFY, gọi `ensureFullSettingsSeeded()` đúng 1 lần tại điểm khởi động
3. `frontend/src/renderer/src/web/web-preload-api.test.ts` (MODIFY)

## Nội dung (xem FE-SOL-STORAGE-003 §4)

```ts
async function ensureFullSettingsSeeded(): Promise<GlobalSettings> {
  const remote = await getFullClientSettings()
  if (remote !== null) return remote
  const local = getStoredSettings()
  await syncFullClientSettings(local)
  return local
}
```

## Test cases cần cover

- `ensureFullSettingsSeeded()` gọi `syncFullClientSettings` đúng 1 lần khi
  `getFullClientSettings()` trả `null`.
- `ensureFullSettingsSeeded()` KHÔNG gọi `syncFullClientSettings` khi đã có
  bản ghi remote — trả thẳng bản remote.
- Gọi `ensureFullSettingsSeeded()` 2 lần liên tiếp (mô phỏng re-mount) —
  lần 2 KHÔNG ghi lại (đã có bản ghi từ lần 1).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/web/web-preload-api.test.ts
```

## gitnexus

`impact({target: "ensureFullSettingsSeeded", direction: "upstream"})` sau
khi thêm — xác nhận chỉ gọi từ đúng 1 điểm khởi động, không bị gọi lặp lại
ở nhiều nơi khác (rủi ro ghi đè không cần thiết nếu gọi nhầm nhiều chỗ).

## Blocking

Không — đây là task cuối của FE-SOL-STORAGE-003.
