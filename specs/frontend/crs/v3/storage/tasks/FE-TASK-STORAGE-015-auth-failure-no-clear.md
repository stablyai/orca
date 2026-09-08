# FE-TASK-STORAGE-015: Auth-failure không còn `.clear()` + phát hiện đổi user

**Solution:** FE-SOL-STORAGE-007 | **CR:** CR-STORAGE-008(a)
**Depends on:** Không (độc lập, làm ngay được)
**Status:** ✅ DONE (2026-09-07)

**Kết quả thực tế:** Đúng như kế hoạch, không có blocker thật sự. Trong
`main-web-bootstrap.tsx`, `installAuthFailedRedirect()` (tên hàm thật khác
với pseudocode `handleAuthFailure()` trong solution doc — cùng vị trí,
cùng auth-failure listener) bỏ 2 lệnh `localStorage.clear()` /
`sessionStorage.clear()`, giữ nguyên redirect + xoá cookie. Thêm hàm mới
`enforceWorkspaceOwnerOnReauth(userId)` gọi từ `WebRoot`'s `useEffect` ngay
khi `sessionUser` resolve (trước khi mirror vào store) — so `ownerUserId`
lưu trong `orca.web.workspaceSession.v1` với `userId` mới; khác thì
`localStorage.clear()`/`sessionStorage.clear()` (đúng như logout), sau đó
luôn (re)stamp `ownerUserId` mới. Thêm field `ownerUserId?: string` vào
`WorkspaceSessionState` (`frontend/src/shared/types.ts`) — chọn type này
(không phải `OrcaInstance`) vì đây là type được ghi tập trung nhất ở
`web-preload-api.ts`, theo đúng gợi ý mặc định của task khi ambiguous;
lý do ghi thành comment tại chỗ khai báo field.
Test file mới `frontend/src/renderer/src/web/main-web-bootstrap.test.ts`
(chưa tồn tại trước đó) — 7 test case: auth-failure không xoá gì + vẫn
redirect + chỉ redirect 1 lần + bỏ qua khi không có session-auth env; cùng
user giữ nguyên state; khác user xoá sạch rồi stamp owner mới; JSON hỏng
không throw và không bị coi là "khác user". `npx vitest run
src/renderer/src/web/main-web-bootstrap.test.ts`: **7/7 pass**. Lint
(`oxlint`) sạch trên cả 3 file sửa. Chạy thêm `npx vitest run
src/renderer/src/web/` (glob rộng hơn) cho thấy 14 test khác fail
(`web-preload-api.test.ts`, `preload-no-change.test.ts`) — xác nhận đây là
do các agent khác đang sửa song song `web-preload-api.ts`/xoá
`preload/index.ts` (thấy trong `git status` lúc đó), KHÔNG liên quan tới
thay đổi của task này (các file đó không đụng tới
`main-web-bootstrap.tsx`).

**Audit "login = state sạch" (mục bắt buộc):** đã rà `onLoginSuccess`,
`onAuthStateChanged` (useIpcEvents.ts's CR-006 desktop path), `clearAuth`.
Không tìm thấy listener nào tự ý reset UI slice mặc định khi thấy sự kiện
đăng nhập thành công — `onAuthStateChanged`'s `'authenticated'` case chỉ
`setCurrentUser`/`setAuthStatus`, không wipe gì; đây cũng là nhánh Electron
desktop (`window.api.auth`), tách biệt khỏi luồng web multi-user trong
`main-web-bootstrap.tsx`. Không có gì cần gỡ/điều kiện hoá.

---

## Mục tiêu

Tách auth-failure (token hết hạn/401/mất kết nối tạm thời) khỏi logout
(ý định xoá dữ liệu tường minh) — chỉ redirect login, KHÔNG xoá
localStorage/sessionStorage, TRỪ KHI phát hiện user đăng nhập lại khác với
user trước đó.

## Files cần sửa

1. `frontend/src/renderer/src/web/main-web-bootstrap.tsx` (MODIFY, dòng ~92, 97)
2. Nơi lưu `WorkspaceSessionState`/`OrcaInstance` — audit thêm field
   `ownerUserId` nếu chưa có (xác định file qua `codegraph explore
   "WorkspaceSessionState OrcaInstance"`)
3. Test file tương ứng

## Nội dung (xem FE-SOL-STORAGE-007 mục (a) cho code đầy đủ)

```ts
function handleAuthFailure() {
  // KHÔNG còn localStorage.clear()/sessionStorage.clear()
  redirectToLogin()
}
```

**Điều kiện bắt buộc — đổi user thì KHÔNG giữ state**: sau đăng nhập lại
thành công, so sánh `user_id` mới với `ownerUserId` đã lưu cùng
`workspaceSession`/`saved-instances`. Nếu khác — chạy đúng luồng xoá như
logout (FE-TASK-STORAGE-016), KHÔNG giữ lại state của user cũ.

## Test cases cần cover

- `handleAuthFailure()` KHÔNG gọi `localStorage.clear()`/`sessionStorage.clear()`.
- `handleAuthFailure()` vẫn gọi `redirectToLogin()`.
- Đăng nhập lại với **cùng** `user_id` → state được giữ nguyên (không xoá).
- Đăng nhập lại với **user_id khác** → chạy luồng xoá đầy đủ (test tích
  hợp với logic ở FE-TASK-STORAGE-016 nếu đã có, hoặc mock nếu làm task
  này trước).

## Rủi ro cần audit trước khi implement (từ solution, bắt buộc)

Rà soát mọi listener trên sự kiện đăng nhập thành công — xác nhận không có
nhánh nào giả định "vừa qua màn hình login = trạng thái sạch" (ví dụ reset
1 số slice UI mặc định). Nếu có, gỡ hoặc điều kiện hoá theo "đây có phải
lần đầu đăng nhập hay resume sau auth-failure".

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/web/main-web-bootstrap.test.ts
```

## gitnexus

`impact({target: "handleAuthFailure", direction: "upstream"})` trước khi
sửa.

## Blocking

Không.
