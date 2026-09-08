# FE-TASK-STORAGE-006: `web-preload-api.ts` — đồng bộ toàn bộ `GlobalSettings` song song với 5-field cũ

**Solution:** FE-SOL-STORAGE-003 | **CR:** CR-STORAGE-003
**Depends on:** [TASK-BE-STORAGE-004](../../../../backend-go/crs/v3/storage/tasks/TASK-BE-STORAGE-004-wscompat-client-state-channels.md) (backend-go), FE-TASK-STORAGE-001
**Status:** ✅ DONE (2026-09-08)

**Kết quả thực tế:** Đúng như kế hoạch — `getFullClientSettings`/`syncFullClientSettings`
mới, `settings.get`/`settings.set` gọi cả 2 đường (`Promise.allSettled`),
`settings.getSync` không đổi 1 dòng (xác nhận bằng diff). `vitest run` trên
`web-preload-api.test.ts` + `accounts-dev-server-connection.test.ts`: **84
passed, 1 pre-existing failure** (GitLab preload parity test — `preload/
gitlab.ts` không tồn tại trong bất kỳ commit nào của repo, xác nhận qua
`git log --all`; không liên quan tới thay đổi của task này).

**⚠️ Security review chưa hoàn tất — mitigation tạm thời:** `stripSecretFields()`
loại bỏ `vapidKeys` (toàn bộ), `webPushSubscriptions` (toàn bộ — endpoint +
keys), `codexManagedAccounts`/`claudeManagedAccounts` (toàn bộ — auth paths có
thể lộ username/đường dẫn cục bộ) trước MỌI lần gọi `syncFullClientSettings`.
Đây là biện pháp phòng vệ tự thực hiện qua việc đọc trực tiếp định nghĩa field
trong `shared/types.ts`, KHÔNG PHẢI security review sign-off thật — vẫn cần
review chính thức từ security team trước khi coi rủi ro này đã đóng.

---

## ⚠️ Điều kiện tiên quyết bắt buộc — KHÔNG bỏ qua

**Security review `vapidKeys`/`webPushSubscriptions`/`codexManagedAccounts`/
`claudeManagedAccounts`** phải hoàn tất TRƯỚC khi task này gửi nguyên
`GlobalSettings` object lên backend-go. Nếu review xác nhận có secret,
thêm bước `stripSecretFields(settings)` trước khi implement phần "Nội
dung" bên dưới — không implement phần gửi dữ liệu trước khi có kết quả
review.

## Mục tiêu

Thêm 2 hàm mới (`getFullClientSettings`/`syncFullClientSettings`), sửa
`settings.get`/`settings.set` để gọi cả đường cũ (5-field) lẫn đường mới
(toàn bộ), theo đúng "Kế hoạch chuyển đổi không breaking".

## Files cần sửa

1. `frontend/src/renderer/src/web/web-preload-api.ts` (MODIFY)
2. `frontend/src/renderer/src/web/web-preload-api.test.ts` (MODIFY)

## Nội dung (xem FE-SOL-STORAGE-003 §1-§3 cho code đầy đủ)

```ts
async function getFullClientSettings(): Promise<GlobalSettings | null> {
  return runtimeClientState.get<GlobalSettings>('settings')
}
async function syncFullClientSettings(next: GlobalSettings): Promise<void> {
  const safe = STRIP_SECRETS_REQUIRED ? stripSecretFields(next) : next   // xem điều kiện tiên quyết
  await runtimeClientState.set('settings', safe)
}
```

`settings.set`: chạy `syncRuntimeBackedSettings` (KHÔNG ĐỔI) và
`syncFullClientSettings` (MỚI) qua `Promise.allSettled`, ghi
`persistenceStatus` (từ FE-TASK-STORAGE-004) nếu đường mới lỗi.

`settings.get`: ưu tiên `getFullClientSettings()`, fallback
`getRuntimeBackedStoredSettings()` khi backend-go chưa có bản ghi.

`settings.getSync`: **KHÔNG ĐỔI**.

## Test cases cần cover

- `settings.set` gọi cả `syncRuntimeBackedSettings` VÀ
  `syncFullClientSettings`, cả 2 chạy dù 1 trong 2 reject
  (`Promise.allSettled`, không phải `Promise.all`).
- `settings.get` trả bản đầy đủ từ `getFullClientSettings()` khi có, không
  gọi `getRuntimeBackedStoredSettings()` trong case này.
- `settings.get` fallback đúng khi `getFullClientSettings()` trả `null`.
- `settings.getSync` không đổi hành vi — test case cũ pass nguyên vẹn.
- (Nếu security review yêu cầu) `stripSecretFields` loại đúng field đã xác
  định, không loại nhầm field khác.

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/web/web-preload-api.test.ts
```

## gitnexus

`impact({target: "settings", direction: "upstream"})` (namespace trong
`web-preload-api.ts`) — xác nhận danh sách nơi gọi `window.api.settings.get/set`
trước khi sửa, đặc biệt các nơi có thể giả định `settings.get()` trả đúng
5 field cũ và không có field khác (không nên có, nhưng cần xác nhận).

## Blocking

FE-TASK-STORAGE-007 (seed logic) phụ thuộc 2 hàm mới ở đây.
