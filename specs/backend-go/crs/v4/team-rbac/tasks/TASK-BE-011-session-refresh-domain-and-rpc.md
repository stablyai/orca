# TASK-BE-011: `RefreshSession` — domain fields, rotation logic, RPC

> **Status: ✅ DONE — 2026-09-09**
>
> **Addendum (2026-09-11, khi thực thi TASK-BE-012):** phát hiện `createSessionForUser` (dùng chung bởi
> `Login`/SSO login) chưa từng set `RefreshTokenHash`/`RefreshExpiresAt` khi tạo session mới — nghĩa là
> `RefreshSession` implement đúng ở đây không có session thật nào để rotate từ (mọi user thật sẽ luôn
> nhận 401 ở `/auth/refresh`). Đã sửa tại TASK-BE-012 (không sửa lại file này) — xem "Kết quả thực tế"
> của TASK-BE-012 cho chi tiết đầy đủ. Bản thân logic rotation/reuse-detection trong task này KHÔNG sai —
> chỉ là chưa có nguồn cấp refresh token thật ở điểm tạo session.

### Kết quả thực tế

- `domain.Session` gained `RefreshTokenHash string` / `RefreshExpiresAt time.Time`, exactly as specified.
- `impact({target:"Session", direction:"upstream", repo:"orca",
  file_path:"backend-go/services/auth-service/internal/domain/session.go"})`: 4 impacted symbols
  (`NewSession` at depth 1; `createSessionForUser` at depth 2; `Login.Execute` and
  `LoginOrProvisionSsoUser.issueSession` at depth 3), 1 module (`Usecase`), 0 processes affected, **risk:
  LOW** — matches the task file's prediction.
- `RefreshSession(RefreshSessionRequest) → RefreshSessionResponse{session_token, expires_at}` RPC added to
  `auth.proto`; `buf generate` run cleanly, no manual edits to generated files needed.
- New usecase `refresh_session.go`: hashes the presented token, looks up via a new
  `SessionRepository.GetSessionByRefreshTokenHash` port method (+ postgres adapter, backed by a new
  partial-unique index — see migration note below); rejects with `apperrors.KindPermissionDenied` (→ gRPC
  `PermissionDenied`, the "403" the task asks for) for unknown/expired/already-revoked tokens; rotates by
  revoking the old session row (kept, not deleted) and creating a brand-new session with fresh
  `TokenHash`/`RefreshTokenHash`.
  **Reuse-detection design decision** (not fully spelled out in the task's schema, which lists no
  session-to-session link field): "revoke the whole session" is implemented as
  `SessionRepository.RevokeAllForUser(userID)` — every session belonging to that user is revoked, not only
  the one the reused token pointed to. This reuses an existing repository method (no new schema needed)
  and is a defensible interpretation of "not just deny the one request," but is a broader blast radius
  than a narrower "revoke just the one successor session" design would be — flagging this choice
  explicitly per the task's own review expectations.
  **Observed spec gap (not fixed, out of scope for this task):** the RPC's response shape
  (`session_token`, `expires_at` only, per this task's own contract) never returns the *new* refresh token
  minted during rotation — so a client that only reads the RPC response has no way to refresh a second
  time; it would need to fall back to a full re-login once its original session_token also expires.
  TASK-BE-012 (api-gateway HTTP route, not in this pass) will need to account for this — either the proto
  needs a `refresh_token` response field added, or some other channel is intended. Noted here per the "if
  you find a wrong premise, stop and note it, don't silently expand scope" instruction; not changed
  because expanding the RPC response shape wasn't asked for by this task's literal spec, and every stated
  acceptance criterion below is satisfiable without it.
- A migration `0007_session_refresh_token.{up,down}.sql` was added (not explicitly listed in this task's
  "What to do," but required to actually persist the two new fields) — adds nullable
  `refresh_token_hash`/`refresh_expires_at` columns to `auth.sessions` plus a partial unique index on
  `refresh_token_hash WHERE refresh_token_hash IS NOT NULL`.
- `internal/adapter/grpc/server.go`: `Server.RefreshSession` wired; `cmd/server/main.go`: `RefreshSession`
  usecase wired with `cfg.SessionTTL` / new `usecase.DefaultRefreshTokenTTL` (30d).
- `refresh_session_test.go` covers all 4 required cases (valid rotation, unknown token, expired token,
  revoked token) plus the explicit reuse-detection test
  (`TestRefreshSession_ReuseOfRotatedAwayTokenRevokesWholeSession`, which seeds a second unrelated session
  for the same user and asserts it too gets revoked after reuse is detected).
- The upstream IdP's OAuth `refresh_token` is untouched — `RefreshSession` only ever reads/writes
  `domain.Session`'s own fields.
- `go build ./services/auth-service/...` and `go test ./services/auth-service/...` clean. `gofmt -l`
  clean on every changed file. `go build ./...` also clean for `api-gateway` (a pre-existing,
  unrelated-to-this-task `go vet` failure exists there — see README update for detail — but it predates
  this change and does not involve any symbol this task touched).

**Solution:** BE-SOL-003 | **CR:** CR-RBAC-003
**Depends on:** none within BE-SOL-003 — independent of the group-mapping tasks (TASK-BE-007..010),
different domain concern (session lifecycle, not role resolution). Still gated behind TASK-BE-003..006
per BE-SOL-003's overall CR-level dependency on the finalized role model, though this specific task
doesn't touch role logic directly.

---

## Goal

`domain.Session` has no refresh-token fields, and there is no session-refresh RPC — only session
issue/revoke exist today. Add rotation-based refresh, explicitly scoped to **Orca's own session
lifecycle**, not the upstream IdP's OAuth refresh token (out of scope, not touched here).

## What to do

1. `backend-go/services/auth-service/internal/domain/session.go`:

```go
type Session struct {
	TokenHash        string
	UserID           string
	TenantID         string
	CreatedAt        time.Time
	ExpiresAt        time.Time
	RevokedAt        *time.Time
	RefreshTokenHash string     // SHA-256 hash, same non-storage-of-raw-token principle as TokenHash
	RefreshExpiresAt time.Time  // typically longer-lived than ExpiresAt (e.g. 30d vs 24h — exact values are a config decision)
}
```

2. New RPC `RefreshSession(refresh_token) → {session_token, expires_at}` on `AuthService`
   (`backend-go/proto/orca/auth/v1/auth.proto`).

3. New usecase `backend-go/services/auth-service/internal/usecase/refresh_session.go`:
   - Hash the presented refresh token, look up by `RefreshTokenHash`.
   - Reject (403, not a generic error) if not found, already revoked, or `RefreshExpiresAt` has passed.
   - **Rotate**: revoke the old session row, issue a brand-new session (new `TokenHash` + new
     `RefreshTokenHash`).
   - **Reuse detection**: if an already-rotated-away refresh token is presented again, revoke the whole
     session (not just deny the one request) — same principle `auth-service.md` §9 documents for the
     not-yet-built mobile/CLI refresh-token family, applied here for browser-session refresh too.
   - Return the new opaque session token.

4. `backend-go/services/auth-service/internal/adapter/grpc/server.go`: wire the `RefreshSession` handler.

## Acceptance Criteria

- [x] `domain.Session` has `RefreshTokenHash`/`RefreshExpiresAt` fields.
- [x] `RefreshSession` RPC added to `auth.proto`; codegen run.
- [x] Valid refresh rotates and returns a new session (new `TokenHash`, new `RefreshTokenHash`).
- [x] Expired, revoked, or unknown refresh token is rejected with a distinguishable error.
- [x] Reuse of an already-rotated-away refresh token revokes the whole session (not just denies the one
      request) — tested explicitly.
- [x] `refresh_session_test.go` covers all 4 cases above.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.
- [x] The upstream IdP's own OAuth `refresh_token` is not stored or touched by this task.

## gitnexus

Not run with numeric results in BE-SOL-003's pass. Run
`impact({target:"domain.Session", direction:"upstream", file_path:"backend-go/services/auth-service/internal/domain/session.go"})`
immediately before implementing — expected LOW risk (auth-service-internal, no other service imports
`domain.Session` directly, per `codegraph_explore`'s "callers" list in the solution pass).

## Blocking

Blocks TASK-BE-012 (api-gateway route needs this RPC to exist).
