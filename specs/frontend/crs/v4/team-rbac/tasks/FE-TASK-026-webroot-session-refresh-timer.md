# FE-TASK-026: Hẹn giờ refresh session định kỳ trong `WebRootBoundary`

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-005](../solutions/FE-SOL-005-session-refresh-before-expiry.md) Bước 2-3
**CR:** [CR-RBAC-003](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-003-sso-group-role-mapping-and-token-refresh.md)
**Priority:** 🟡 P1
**Estimated:** 30 phút
**Status:** ✅ DONE — 2026-09-09

## Mục tiêu

`WebRootBoundary` là nơi duy nhất gọi `fetchCurrentUser()` lúc bootstrap — 1 lần, không lặp lại.
Thêm `setInterval` gọi `refreshSession()` định kỳ (poll cố định, không cần backend trả
`expiresAt` — giữ `AuthUser` shape không đổi).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/web/main-web-bootstrap.tsx` | MODIFY — `WebRootBoundary` thêm `useEffect` hẹn giờ refresh |

## Các bước thực thi

Đặt `useEffect` này trong `WebRootBoundary` (nơi đã giữ `sessionUser` state) — **không** đặt trong
`WebRoot`, để tránh chạy lại mỗi khi `WebRoot` re-render vì lý do khác auth:

```typescript
// CR-RBAC-003: session Orca tự issue có TTL cố định phía server (xem
// backend-go's domain.Session) — refresh định kỳ ở khoảng thời gian ngắn hơn
// hẳn TTL đó (ví dụ 15 phút nếu TTL là 24h) để không bao giờ chạm hạn khi tab
// vẫn mở, mà không cần backend trả expiresAt (giữ AuthUser shape không đổi).
const SESSION_REFRESH_INTERVAL_MS = 15 * 60 * 1000

useEffect(() => {
  if (sessionUser === null) {return}
  const timer = setInterval(() => {
    refreshSession()
      .then((refreshed) => {
        if (refreshed === null) {
          // Session đã bị revoke — không silently issue token mới (đúng
          // tiêu chí chấp nhận CR-003). Đăng xuất mềm: reload để
          // WebRootBoundary tự phát hiện lại qua fetchCurrentUser().
          window.location.href = '/'
        }
      })
      .catch(() => {
        // Lỗi mạng thoáng qua — không logout, thử lại ở lần interval kế tiếp.
      })
  }, SESSION_REFRESH_INTERVAL_MS)
  return () => clearInterval(timer)
}, [sessionUser])
```

Không cần đổi `checkSession`/`AuthSlice` — thành công thì user identity không đổi (rotation chỉ đổi
session token trong cookie phía server), thất bại thì điều hướng lại `/` để luồng bootstrap hiện có
tự xử lý.

## Verify

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
```

Test tích hợp (yêu cầu backend đã có `POST /auth/refresh`, chạy sau khi backend-go xong): session
sắp hết hạn → refresh tự động, không cần đăng nhập lại; session bị revoke (admin force-logout) →
refresh trả 403 → client điều hướng về login, không silently issue token mới.

## Không làm ở task này

- UI hiển thị "session sắp hết hạn" cho người dùng — refresh hoàn toàn ngầm (silent).
- Đổi `AuthUser` để thêm `expiresAt` — chọn hướng poll cố định để tránh đổi response shape.

## Depends on

FE-TASK-025 (`refreshSession()` phải tồn tại).

## Blocking

FE-TASK-027 (FE-SOL-006 khuyến nghị chờ FE-SOL-005 xong trước khi thiết kế SAML chi tiết hơn).

## Kết quả thực tế (2026-09-09)

Đã làm FE-TASK-025 trước (như "Depends on" yêu cầu) nên `refreshSession()` đã sẵn sàng khi thực thi
task này. Xác nhận vị trí `WebRootBoundary` bằng `grep -n "WebRootBoundary|sessionUser|useEffect"
frontend/src/renderer/src/web/main-web-bootstrap.tsx` — hàm ở dòng 297+ (đã dịch xuống so với audit
gốc do các sửa đổi trước đó của FE-TASK-008 trong cùng file, nhưng cùng 1 hàm, đúng vị trí giữ
`sessionUser` state như task yêu cầu). `impact({target: "fetchCurrentUser", ...})` (dùng lại kết quả
từ FE-TASK-025) xác nhận `WebRootBoundary` có 1 direct dependent (`bootstrapWebApp`) — risk LOW,
khớp mô tả "nơi duy nhất gọi fetchCurrentUser lúc bootstrap".

Đã thêm đúng `useEffect` hẹn giờ refresh (interval 15 phút, `SESSION_REFRESH_INTERVAL_MS`) vào
`WebRootBoundary` — **không** đặt trong `WebRoot` (đúng lưu ý của task, vì `WebRoot` re-render vì lý
do khác auth có thể chạy lại effect không cần thiết). Copy nguyên code mẫu từ task, giữ nguyên toàn
bộ comment CR-RBAC-003. Đã import thêm `refreshSession` từ `auth-api-client.ts`. Không đổi
`checkSession`/`AuthSlice`, không thêm UI hiển thị "sắp hết hạn", không đổi `AuthUser` shape — đúng
"Không làm ở task này".

`tsc --noEmit`: không phát sinh lỗi mới (diff với baseline 147-dòng = rỗng). `npx vitest run
src/renderer/src/web/main-web-bootstrap.test.ts`: 7/7 test pass, không cần sửa test nào (test hiện
có không cover phần polling định kỳ — test tích hợp thật cho refresh/revoke như task ghi vẫn chờ
`POST /auth/refresh` tồn tại ở backend-go). Không có gì khác biệt so với kế hoạch.
