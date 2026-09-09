# FE-TASK-025: Thêm `refreshSession()` vào `auth-api-client.ts` + test

**Domain:** team-rbac
**Solution Ref:** [FE-SOL-005](../solutions/FE-SOL-005-session-refresh-before-expiry.md) Bước 1
**CR:** [CR-RBAC-003](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-003-sso-group-role-mapping-and-token-refresh.md)
**Priority:** 🟡 P1
**Estimated:** 30 phút
**Status:** ✅ DONE — 2026-09-09

## ⚠️ Phụ thuộc backend-go

`POST /auth/refresh` (`RefreshSession` RPC, `domain.Session` thêm refresh-token field) **chưa tồn
tại** ở backend-go — `grep -rn "auth/refresh" frontend/src backend-go` không ra kết quả nào ngoài
chính CR document. **Depends on:** backend-go's BE-TASK tương ứng của CR-RBAC-003 (xem
`specs/backend-go/crs/v4/team-rbac/tasks/`, đang soạn song song). Task này viết được ngay (chỉ gọi
`fetch('/auth/refresh', ...)`, không cần backend tồn tại để code/unit-test với `fetch` mock) —
nhưng **test tích hợp thật** (gọi backend thật) phải chờ backend-go xong.

## Files cần sửa

| File | Action |
|------|--------|
| `frontend/src/renderer/src/auth/auth-api-client.ts` | MODIFY — thêm `refreshSession()` |
| `frontend/src/renderer/src/auth/__tests__/auth-api-client.test.ts` | MODIFY — test `refreshSession()` (200/401/403/network error) |

## Các bước thực thi

**`auth-api-client.ts`:**

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

**Test** — mock `fetch`, cover 4 case: 200 (trả `AuthUser`), 401, 403 (cả 2 trả `null`), lỗi mạng
(reject), 500 (throw `Error`).

## Verify

```bash
cd frontend && npx vitest run src/renderer/src/auth/__tests__/auth-api-client.test.ts
cd frontend && npx tsc --noEmit -p tsconfig.json
```

## Depends on

Không có (code FE độc lập). Backend-go's `POST /auth/refresh` cần xong cho test tích hợp thật (xem
cảnh báo ở đầu).

## Blocking

FE-TASK-026.

## Kết quả thực tế (2026-09-09)

Xác nhận lại cảnh báo backend-go: `grep -rn "auth/refresh" frontend/src backend-go` (chạy lại tại
thời điểm implement) vẫn không ra kết quả nào ngoài chính CR document — `POST /auth/refresh` vẫn
chưa tồn tại ở backend-go, đúng như task ghi. `impact({target: "fetchCurrentUser", direction:
"upstream", file_path: "frontend/src/renderer/src/auth/auth-api-client.ts"})` xác nhận
`impactedCount = 3, risk: LOW` (`WebRootBoundary` → `bootstrapWebApp` → `main.tsx`) — cùng module
`refreshSession()` được thêm vào, không có gì bất ngờ.

Đã thêm `refreshSession()` vào `frontend/src/renderer/src/auth/auth-api-client.ts` đúng y hệt code
mẫu trong task (401/403 → `null`, không throw; !ok → throw `Error`). Đã thêm 5 test case vào
`frontend/src/renderer/src/auth/__tests__/auth-api-client.test.ts` (200, 403, 401, 500, network
error) — nhiều hơn 1 case so với "4 case" liệt kê trong task (tách 401 và 403 thành 2 case riêng
thay vì gộp "cả 2 trả null" thành 1 case, để rõ ràng hơn khi 1 trong 2 status đổi hành vi sau này).

`npx vitest run src/renderer/src/auth/__tests__/auth-api-client.test.ts`: 15/15 test pass (10 test
cũ + 5 test mới). `tsc --noEmit`: không phát sinh lỗi mới (diff với baseline 147-dòng = rỗng). Không
có gì khác biệt so với kế hoạch ngoài số lượng test case tách nhỏ hơn dự kiến.
