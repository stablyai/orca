# TASK-BE-030: Wire `admin.*Session*` wscompat channels

> **Status: 🔲 TODO — not implemented**

> **Status: ✅ DONE — 2026-09-11**

**Solution:** BE-SOL-008 §2.2 | **CR:** CR-RBAC-001
**Depends on:** TASK-BE-002 (`ForceRevokeSession` RPC — implemented 2026-09-11, see that task's "Lịch sử
ngắn" for why `RevokeSession` could NOT be reused: it expects a raw token, `ListSessionsForUser`'s
`Session.id` is already a hash). `admin.listSessions`/`admin.forceRevokeAllSessions` have no dependency.

## Kết quả thực tế

3 channel đăng ký trong `channels_admin_sessions.go` (mới): `admin.listSessions` ({userId} →
`ListSessionsForUser` → `{sessions: sessionView[]}`), `admin.forceRevokeAllSessions` ({userId} →
`ForceRevokeAllSessionsForUser` → `{revokedCount}`), `admin.forceRevokeSession` ({sessionId} →
`ForceRevokeSession` → `{ok:true}`) — field map theo đúng `Session` proto thật (`Id, UserId, CreatedAt,
ExpiresAt, LastSeenAt, Ip, UserAgent`, xác nhận qua `auth.pb.go`, khác 1 chút so với sketch gốc trong
BE-SOL-008 — dùng `ip`/`userAgent` không phải `ipAddress`). `go build`/`go test` sạch cho `api-gateway`
(3 test mới, admin-gate + happy path cho cả 3 channel).

---

## Goal

Wire session-management to `window.api.admin.*`: list a user's sessions, force-revoke all of a user's
sessions, and force-revoke one specific session.

## What to do

Create `backend-go/services/api-gateway/internal/adapter/wscompat/channels_admin_sessions.go`, following
`channels_admin_users.go`'s exact pattern (admin-gate, decode args, `AttachIdentity`, call, view struct):

```go
type sessionView struct {
	SessionID        string `json:"sessionId"`
	UserID           string `json:"userId"`
	IPAddress        string `json:"ipAddress"`
	UserAgent        string `json:"userAgent"`
	CreatedAtUnixMs  int64  `json:"createdAtUnixMs"`
	LastSeenAtUnixMs int64  `json:"lastSeenAtUnixMs"`
}

func registerAdminSessionChannels(r *Registry, client authv1.AuthServiceClient) {
	r.Register("admin.listSessions", /* {userId} -> ListSessionsForUser -> {sessions: sessionView[]} */)
	r.Register("admin.forceRevokeAllSessions", /* {userId} -> ForceRevokeAllSessionsForUser -> {ok:true} */)
	r.Register("admin.forceRevokeSession", /* {sessionId} -> ForceRevokeSession (or RevokeSession, per
		TASK-BE-001/002's finding) -> {ok:true} */)
}
```

Field-map `sessionView` from whatever `ListSessionsForUserResponse`'s session message actually exposes —
confirm exact proto field names via `codegraph_explore` before writing (BE-SOL-008's sketch assumed
`ip_address`/`user_agent`/`created_at`/`last_seen_at` by analogy with the domain's `Session`, not yet
verified against the generated `.pb.go`).

Add `registerAdminSessionChannels(r, authClient)` to `RegisterRealChannels` in `channels.go`.

## Acceptance Criteria

- [ ] 3 channels registered: `admin.listSessions`, `.forceRevokeAllSessions`, `.forceRevokeSession`.
- [ ] `admin.forceRevokeSession` calls whichever RPC TASK-BE-001/002 concluded is correct — **verify this
      before writing the channel, don't guess**.
- [ ] Each rejects non-admin `Identity` with `errNotAdmin` (test per channel).
- [ ] `go build ./...` and `go test ./...` clean for `api-gateway`.

## gitnexus

Run `impact({target:"ForceRevokeAllSessionsForUser", direction:"upstream"})` before adding
`admin.forceRevokeSession` alongside it (BE-SOL-001 §7 already flagged this as the check to run before
implementing `ForceRevokeSession`'s usecase — re-run here at the wscompat layer too).

## Blocking

`admin.forceRevokeSession` blocks on TASK-BE-002. The other 2 channels in this file do not — implement
them first if TASK-BE-002 hasn't landed yet, and add the third channel as a small follow-up diff to this
same file once it has.
