# TASK-BE-012: `POST /auth/refresh` route in api-gateway

> **Status: ✅ DONE — 2026-09-11**
>
> **Kết quả thực tế:** Đúng như kế hoạch, cộng 1 gap nghiêm trọng phát hiện và sửa (không nằm trong mô
> tả gốc của task, nhưng bắt buộc phải sửa để route này có ý nghĩa thật):
>
> **Gap phát hiện: không session nào tạo qua `Login`/`CompleteSsoLogin` từng có refresh token.**
> `RefreshSession` (TASK-BE-011) tra cứu session BẰNG hash của refresh token
> (`GetSessionByRefreshTokenHash`) — nhưng `createSessionForUser` (helper dùng chung bởi `Login.Execute`
> và SSO's `issueSession`) chưa bao giờ set `RefreshTokenHash`/`RefreshExpiresAt` khi tạo session mới.
> Kết quả: `/auth/refresh` sẽ luôn 401 cho MỌI user thật (không có refresh token nào để trình ra), dù unit
> test của TASK-BE-011 vẫn pass (vì test tự dựng session có sẵn `RefreshTokenHash`, không đi qua login
> thật). Đã sửa tận gốc:
> - `createSessionForUser` (login.go) nay generate + set cả refresh token cho MỌI session mới (dùng lại
>   `DefaultRefreshTokenTTL` đã có ở `refresh_session.go`).
> - `LoginOutput`/`LoginOrProvisionSsoUserOutput` thêm field `RefreshToken`.
> - `auth.proto`: `LoginResponse`/`CompleteSsoLoginResponse` thêm field `refresh_token` (đã `buf generate`
>   lại — diff lớn vì bundle luôn cả các thay đổi proto khác từ 1 phiên không liên quan đang chạy song
>   song, đã verify build sạch cho `automation-service`/`infra-fleet-service`/`notification-service`/
>   `workflow-service` sau khi regenerate).
> - `server.go`'s `Login`/`CompleteSsoLogin` handler trả `RefreshToken` trong response.
> - **Cũng phát hiện và sửa nốt**: `server.go`'s `RefreshSession` handler (chính route này gọi) thiếu map
>   `out.RefreshToken` (usecase đã trả đúng từ TASK-BE-011, nhưng response proto bị bỏ sót field) — đây là
>   chỗ 1 phiên trước đó (bị gián đoạn giữa chừng do rate limit) đã đọc/build proto xong nhưng chưa kịp
>   sửa; hoàn tất nốt.
>
> `/auth/local`, `handleSsoCallback` set thêm cookie `orca_refresh` (Path `/auth` — hẹp hơn `orca_session`
> vì chỉ `/auth/refresh` và `/auth/logout` cần đọc nó), `/auth/logout` xoá cả 2 cookie. `POST /auth/refresh`
> đọc `orca_refresh`, gọi `RefreshSession`, set lại cả 2 cookie mới, gọi `ValidateSession` để lấy `User`
> (vì `RefreshSessionResponse` không mang `User`), trả đúng shape `authUserResponse` khớp
> `frontend/`'s `refreshSession()` (`auth-api-client.ts`, đã kiểm tra trực tiếp: `POST /auth/refresh`,
> `credentials:'include'`, không body, kỳ vọng `AuthUser` JSON hoặc 401/403→null).
>
> **Phát sinh ngoài ý muốn (đã xử lý, không phải lỗi của route này)**: `go test` cho
> `httpgateway` package fail biên dịch do `fakeNotificationServiceClient` (1 phiên khác, CR-NOTIF-001,
> đang chạy song song) thiếu 4 method mới trên interface (`GetUnreadCount`, `ListNotifications`,
> `MarkAsRead`, `MarkAllAsRead`) — đã thêm stub `Unimplemented` tối thiểu (đúng pattern
> `StreamNotifications` đã có sẵn trong cùng file) để unblock biên dịch cho TOÀN package, không đổi hành
> vi bất kỳ test nào khác. Không đụng vào phần còn lại của tính năng CR-NOTIF-001.
>
> Test mới: `TestAuthRefresh_NoCookiePresent_Returns401`, `TestAuthRefresh_Success_RotatesBothCookiesAndReturnsUser`,
> `TestAuthRefresh_InvalidToken_ClearsBothCookiesAndReturns401` — 3/3 pass. Toàn bộ
> `go test ./internal/adapter/httpgateway/...` pass. `go build`/`go test` sạch cho `auth-service` +
> `api-gateway`. `gofmt -l` sạch trên mọi file đã sửa.

**Solution:** BE-SOL-003 | **CR:** CR-RBAC-003
**Depends on:** TASK-BE-011 (`RefreshSession` RPC must exist first).

---

## Goal

Expose `RefreshSession` as an HTTP route, mirroring the existing `/auth/local` login route's
cookie-setting shape exactly, so the browser session cookie gets refreshed the same way login sets it.

## What to do

In `backend-go/services/api-gateway/internal/adapter/httpgateway/auth_routes.go`, add
`POST /auth/refresh`:

- Read the current refresh token (wherever the existing session-cookie mechanism stores/reads it — verify
  the exact source before implementing, not re-read in BE-SOL-003's pass).
- Call `AuthServiceClient.RefreshSession`.
- On success, set the `orca_session` cookie again using the **same** `Secure`/`HttpOnly`/`SameSite=Strict`
  posture `Login` already uses — reuse whatever helper already sets the session cookie on `Login`'s
  response (verify its exact name before implementing).
- On rejection (expired/revoked/reused refresh token), return the same error shape `Login` uses for
  auth failures, not a generic 500.

## Acceptance Criteria

- [x] `POST /auth/refresh` route added to `auth_routes.go`.
- [x] Successful refresh sets the `orca_session` cookie with identical security attributes to `Login`'s
      cookie-setting code path (reused `setSessionCookie` verbatim) — plus a new `orca_refresh` cookie
      (narrower `Path: "/auth"`).
- [x] Rejected refresh (expired/revoked/reused token) returns a client error (401), not a 500 — and
      clears both cookies so the client doesn't retry a dead refresh token.
- [x] Route-level test (`auth_routes_test.go`) covering success, no-cookie, and rejection paths — 3/3 pass.
- [x] `go build ./...` / `go test ./...` clean for `api-gateway` (and `auth-service`, for the
      `createSessionForUser`/proto fix this task also required).

## gitnexus

Not run in BE-SOL-003's pass — run `impact({target:"auth_routes", direction:"upstream"})` or
`codegraph_explore("auth_routes.go Login cookie")` before editing, to confirm the exact cookie-setting
helper to reuse and its other callers.

## Blocking

Blocked on TASK-BE-011.
