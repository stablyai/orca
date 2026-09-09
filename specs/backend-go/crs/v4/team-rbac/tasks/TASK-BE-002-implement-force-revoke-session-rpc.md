# TASK-BE-002: Add `ForceRevokeSession` RPC (admin single-session kill) — only if TASK-BE-001 confirms the gap

> **Status: ✅ DONE — 2026-09-11 — implemented (reopened after a refined finding)**
>
> **Lịch sử ngắn:** ban đầu đóng lại là "not needed" vì `RevokeSession` có vẻ đã đủ (admin-gated, nhận
> session của bất kỳ user nào). Khi làm TASK-BE-030 (wire wscompat), phát hiện sâu hơn: `RevokeSession`
> nhận **raw token chưa hash** rồi tự hash để tra cứu — nhưng `ListSessionsForUser`'s `Session.id` trả về
> **đã là hash** (theo đúng thiết kế bảo mật, raw token không bao giờ lộ ra ngoài phiên đăng nhập gốc).
> Admin xem Sessions tab chỉ có hash, không bao giờ có raw token của session người khác → gọi thẳng
> `RevokeSession(session_token: <hash>)` sẽ hash cái hash đó lần 2, không bao giờ khớp, action "kill 1
> session" trên UI sẽ luôn thất bại âm thầm (`AUTH_SESSION_NOT_FOUND`). Xem TASK-BE-001's "Sửa lại kết
> luận" để biết đầy đủ.
>
> **Đã implement thật** (đúng theo mô tả gốc của task này, dùng lại code sketch có sẵn):
> - `auth.proto`: RPC `ForceRevokeSession(ForceRevokeSessionRequest{session_id}) → Empty` — `session_id`
>   là hash, không phải raw token (ghi rõ trong proto comment).
> - `force_revoke_session.go` (usecase mới): admin-gated qua `requireAdminActor`, gọi thẳng
>   `SessionRepository.RevokeSession(ctx, sessionID, now)` ở TẦNG REPOSITORY (nhận hash trực tiếp, không
>   tự hash lại — khác với usecase `RevokeSession` cùng tên nhưng khác tầng), tra session trước để audit
>   đúng `UserID` mục tiêu, fail closed đúng pattern `errors.Is(err, ErrSessionNotFound)` của
>   `revoke_session.go`.
> - `server.go`/`main.go`: wire field + constructor param + handler, mirroring
>   `ForceRevokeAllSessionsForUser`'s vị trí trong composition root.
> - Test mới (`force_revoke_session_test.go`, 4/4 pass): OPA deny, **revoke-bằng-hash-trực-tiếp** (guard
>   chính — seed session với `TokenHash` đã là hash, gọi `Execute(ctx, hash)` thẳng, không qua bước hash
>   lại), unknown session-id → 404, session-id rỗng → invalid argument.
> - `go build`/`go test` sạch cho `auth-service`. `gofmt -l` sạch. Không đổi `RevokeSession` cũ (vẫn giữ
>   nguyên cho path raw-token nếu nơi khác dùng).
>
> **TASK-BE-030 đã cập nhật** để gọi đúng `ForceRevokeSession` (không phải `RevokeSession`) cho channel
> `admin.forceRevokeSession`.

**Solution:** BE-SOL-001 | **CR:** CR-RBAC-001
**Depends on:** TASK-BE-001 (must confirm the gap is real before any of this is written; if TASK-BE-001
concludes `RevokeSession` already supports an admin target, this task is a no-op — do not implement it
anyway).

---

## Goal

Add an admin-gated RPC to revoke one specific session (distinct from `RevokeSession`, the caller's-own
logout path, and `ForceRevokeAllSessionsForUser`, which kills every session for a user) — needed to back
CR-RBAC-001's Admin Sessions tab "kill one session" row action.

## What to do

Only proceed if TASK-BE-001 confirmed the gap is real. Then, mirroring
`ForceRevokeAllSessionsForUser`'s exact existing shape:

1. `backend-go/proto/orca/auth/v1/auth.proto`:

```protobuf
// ForceRevokeSession is the admin-console single-session kill action —
// distinct from RevokeSession (caller revokes their OWN session, the
// logout path) and ForceRevokeAllSessionsForUser (kill every session for a
// user). Added for CR-RBAC-001's Sessions tab.
rpc ForceRevokeSession(ForceRevokeSessionRequest) returns (google.protobuf.Empty);

message ForceRevokeSessionRequest {
  string session_id = 1; // the opaque token's hash, as returned by ListSessionsForUser
}
```

Run `buf generate` (or whatever this repo's proto codegen entrypoint is) after editing the proto.

2. New usecase `backend-go/services/auth-service/internal/usecase/force_revoke_session.go` — a 1:1 copy
   of `force_revoke_all_sessions_for_user.go`'s shape: gated by `requireAdminActor` (identical pattern to
   every other admin usecase in this service), but calling `SessionRepository.RevokeSession` (already
   exists, confirmed at `postgres/session_repository.go:44-56`) for one `token_hash` instead of
   `RevokeAllForUser`.

3. `backend-go/services/auth-service/internal/adapter/grpc/server.go`: wire the new RPC handler.

## Acceptance Criteria

- [x] `ForceRevokeSession` RPC added to `auth.proto`, generated code committed.
- [x] `force_revoke_session.go` usecase: admin-gated via `requireAdminActor`, revokes exactly one session
      by `token_hash`/`session_id`.
- [x] `force_revoke_session_test.go`: admin caller revokes another user's specific session succeeds;
      non-admin caller is denied (mirrors `requireAdminActor`'s existing test pattern across this
      service's other admin usecases).
- [x] `go build ./...` and `go test ./...` clean for `auth-service`.
- [x] No other service/module touched.

## gitnexus

- Run `impact({target:"ForceRevokeAllSessionsForUser", direction:"upstream"})` before writing this task's
  code, to confirm the existing RPC's blast radius and reuse its exact wiring pattern safely (BE-SOL-001
  §7 flags this as not yet run in the solution pass).
- Run `detect_changes({scope:"compare", base_ref:"main"})` before committing.

## Blocking

Blocked on TASK-BE-001's conclusion. If TASK-BE-001 finds the gap is not real, skip this task entirely —
do not implement a redundant RPC.
