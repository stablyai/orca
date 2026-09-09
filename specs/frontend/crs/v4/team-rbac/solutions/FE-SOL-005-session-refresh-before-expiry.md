# FE-SOL-005: Gọi `/auth/refresh` trước khi session hết hạn (silent renew)

> 🔲 Proposed — chưa cài đặt.

## CR Reference

- **CR:** [CR-RBAC-003](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-003-sso-group-role-mapping-and-token-refresh.md)
- **Mức độ:** 🟡 P1
- **Phạm vi solution này:** CHỈ phần B ("Token refresh") của CR-RBAC-003, và chỉ phần client. Phần
  A (group→role mapping OIDC/GitHub) là backend-go thuần, không có việc FE nào — chỉ ghi nhận ở
  README. Phần backend của phần B (`RefreshSession` RPC, `POST /auth/refresh`, `domain.Session`
  thêm refresh-token field) là điều kiện tiên quyết bắt buộc, chưa tồn tại — xác nhận `grep -rn
  "auth/refresh" frontend/src backend-go` không ra kết quả nào ngoài chính CR document.

## Impact analysis (gitnexus, đã chạy lại)

| Symbol | Direction | Risk | Impacted | Ghi chú |
|---|---|---|---|---|
| `fetchCurrentUser` (`auth/auth-api-client.ts`) | upstream | LOW | 3 (`WebRootBoundary`→`bootstrapWebApp`→`main.tsx`) | Nơi thêm hook gọi refresh nằm cạnh (`WebRootBoundary`'s `useEffect`) |
| `checkSession` (`store/slices/auth.ts`) | upstream | LOW | 0 | Không đổi chữ ký, chỉ thêm 1 action mới `scheduleSessionRefresh` cạnh nó |

## Bối cảnh (đã xác nhận lại)

- `frontend/src/renderer/src/auth/auth-api-client.ts` (đã đọc verbatim): chỉ có
  `fetchCurrentUser`/`loginLocal`/`logoutUser`/`fetchAuthConfig`, không có hàm refresh nào — đúng
  audit gốc "không lưu token ở client, `credentials:'include'`".
- `frontend/src/renderer/src/hooks/useAuthSession.ts` (đã đọc verbatim): chỉ có
  `useAuthStatus`/`useAuthUser`/`useAuthSession` (đọc store), không có logic hẹn giờ/polling nào.
- `WebRootBoundary` (`web/main-web-bootstrap.tsx`, đã đọc verbatim) là nơi duy nhất gọi
  `fetchCurrentUser()` lúc bootstrap — 1 lần, không lặp lại, không có `setInterval`/`setTimeout` nào
  liên quan tới auth trong toàn bộ `web/` — xác nhận đúng gap "chỉ session issue/revoke, không có
  silent renew" nêu trong CR.
- Backend chưa expose thời điểm hết hạn của session cho client (`AuthUser` không có trường
  `expiresAt`) — `GET /auth/me` hiện chỉ trả `{id,email,name,role,provider,avatarUrl}`. Vì vậy chiến
  lược "gọi refresh N phút trước khi hết hạn" cần backend trả thêm `expiresAt`/`refreshAfter` trên
  `AuthUser`, HOẶC (đơn giản hơn, khuyến nghị cho MVP) refresh theo lịch cố định (poll mỗi X phút,
  X nhỏ hơn hẳn session TTL) — không cần backend đổi response shape. Solution này chọn hướng poll
  cố định để không phụ thuộc thêm 1 thay đổi backend ngoài `POST /auth/refresh` đã có trong CR.

## Giải pháp

### Bước 1 — Thêm `refreshSession()` vào `auth-api-client.ts`

**File:** `frontend/src/renderer/src/auth/auth-api-client.ts` (MODIFY)

```typescript
// ─── POST /auth/refresh ─────────────────────────────────────────────────────
// CR-RBAC-003: rotation — server issue session mới, revoke session cũ. Trả
// null khi session đã bị revoke/hết hạn quá hạn refresh (403) — không throw,
// để caller quyết định logout thay vì crash UI.
export async function refreshSession(): Promise<AuthUser | null> {
  const res = await fetch('/auth/refresh', { method: 'POST', credentials: 'include' })
  if (res.status === 403 || res.status === 401) {return null}
  if (!res.ok) {throw new Error(`Server error: ${res.status}`)}
  return res.json() as Promise<AuthUser>
}
```

### Bước 2 — Hẹn giờ refresh định kỳ, gắn vào `WebRootBoundary`

**File:** `frontend/src/renderer/src/web/main-web-bootstrap.tsx` (MODIFY)

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

Đặt `useEffect` này trong `WebRootBoundary` (nơi đã giữ `sessionUser` state), không phải trong
`WebRoot` — tránh chạy lại mỗi khi `WebRoot` re-render vì lý do khác auth.

### Bước 3 — Không đổi `checkSession`/`AuthSlice`

Refresh không cần thay đổi state shape (`OrcaUser`/`AuthStatus`) — thành công thì user identity
không đổi (rotation chỉ đổi session token trong cookie, phía server), thất bại thì điều hướng lại
`/` để luồng bootstrap hiện có tự xử lý (đã có `checkSession`/`fetchCurrentUser` lo phần
authenticated/unauthenticated).

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/auth/auth-api-client.ts` | MODIFY — thêm `refreshSession()` |
| `frontend/src/renderer/src/web/main-web-bootstrap.tsx` | MODIFY — `WebRootBoundary` thêm `useEffect` hẹn giờ refresh |
| `frontend/src/renderer/src/auth/__tests__/auth-api-client.test.ts` | MODIFY — test `refreshSession()` (200/401/403/network error) |

## Verification (khi cài đặt)

```bash
cd frontend && npx vitest run src/renderer/src/auth/__tests__/auth-api-client.test.ts
cd frontend && npx tsc --noEmit -p tsconfig.json
```

Test tích hợp (yêu cầu backend đã có `POST /auth/refresh`): session sắp hết hạn → refresh tự động,
không cần đăng nhập lại; session bị revoke (admin force-logout) → refresh trả 403 → client điều
hướng về login, không silently issue token mới — đúng tiêu chí chấp nhận CR-003.

## Không làm ở solution này

- Group→role mapping (phần A của CR-003) — backend-go thuần túy, không có việc FE.
- Renew OAuth token gốc với IdP (Google/GitHub/OIDC) — CR-003 xác nhận rõ chỉ refresh session nội
  bộ Orca.
- Đổi `AuthUser` để thêm `expiresAt` — chọn hướng poll cố định để tránh đổi response shape (xem
  Bối cảnh); nếu backend sau này thêm `expiresAt`, có thể tối ưu lại thành lịch động ở 1 solution
  khác.
- UI hiển thị "session sắp hết hạn" cho người dùng — refresh hoàn toàn ngầm (silent), đúng tinh
  thần "silent renew" của CR.
