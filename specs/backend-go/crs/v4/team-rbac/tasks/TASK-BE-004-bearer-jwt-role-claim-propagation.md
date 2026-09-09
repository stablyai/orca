# TASK-BE-004: Give the bearer-JWT auth path a `Role` claim to propagate

> **Status: ✅ DONE — 2026-09-09**
> **Files modified:** `backend-go/common/jwtauth/jwtauth.go`,
> `backend-go/services/auth-service/internal/usecase/issue_service_token.go`,
> `backend-go/services/api-gateway/internal/usecase/validate_identity.go`,
> `backend-go/common/tenant/tenant.go` (doc comment, shared with TASK-BE-003)
>
> **Kết quả thực tế:** All 3 steps implemented exactly per the code sketch — `jwtauth.Claims` gained
> `Role string` (`json:"role,omitempty"`), `IssueServiceToken.Execute`'s claims literal sets
> `Role: string(user.Role)`, and `validate_identity.go`'s `Validate` returns `Identity{..., Role:
> claims.Role}`. `Identity.Role`'s doc comment updated to state the bearer path now populates it (no
> longer "never populates"). Backward compatibility verified: `Role` has `omitempty` and
> `validate_identity.go` never rejects an empty `claims.Role` — a pre-existing JWT with no `role` claim
> still validates with `Identity.Role == ""`. `go build ./...` clean for the whole repo (all modules);
> `go test ./...` clean for `common/jwtauth` (no dedicated Claims test existed to update), `auth-service`,
> and `api-gateway`. `gofmt -l` clean.

**Solution:** BE-SOL-002 | **CR:** CR-RBAC-002
**Depends on:** none — can run in parallel with TASK-BE-003 (different files, same overall CR).

---

## Goal

The cookie/session auth path already propagates the caller's role end-to-end (verified in BE-SOL-002 §2).
The bearer-JWT path does not — `jwtauth.Claims` has no `Role` field, so `Identity.Role` is never populated
for tokens minted via `IssueServiceToken`. There is no live browser/mobile "login → bearer JWT" flow in
production yet, but this closes the gap before CR-RBAC-003 ships real user-facing token issuance (so it
doesn't silently regress once that lands).

## What to do

1. `backend-go/common/jwtauth/jwtauth.go`:

```go
type Claims struct {
	jwt.Claims
	TenantID string `json:"tenant_id,omitempty"`
	// Role is the caller's global role ("admin"/"user") at token-issuance
	// time — added so a bearer-JWT-authenticated caller propagates the same
	// role claim the cookie/session path already does (BE-SOL-002).
	Role string `json:"role,omitempty"`
}
```

2. `backend-go/services/auth-service/internal/usecase/issue_service_token.go`'s `Execute` already loads
   `user` via `uc.users.GetUserByID` — add one field to the `claims` literal:

```go
claims := jwtauth.Claims{
	Claims: jwt.Claims{ /* unchanged */ },
	TenantID: user.TenantID,
	Role:     string(user.Role),
}
```

3. `backend-go/services/api-gateway/internal/usecase/validate_identity.go`'s `Validate`:

```go
if claims.TenantID == "" || claims.Subject == "" {
	return Identity{}, ErrMissingIdentityClaims
}
return Identity{TenantID: claims.TenantID, UserID: claims.Subject, Role: claims.Role}, nil
```

4. Update `usecase.Identity.Role`'s doc comment (`validate_identity.go`) — it currently says the bearer
   path never populates it; that claim becomes stale once this lands.

`AttachIdentity`/`TenantExtractionInterceptor` already forward `Identity.Role` once it's populated — no
new plumbing needed beyond these 3 files.

## Acceptance Criteria

- [x] `jwtauth.Claims` has a `Role string` field with `json:"role,omitempty"`.
- [x] `IssueServiceToken`'s minted claims include `Role: string(user.Role)`.
- [x] `validate_identity.go`'s `Validate` returns `Identity.Role` populated from `claims.Role`.
- [x] `Identity.Role`'s doc comment updated to no longer claim the bearer path never populates it.
- [x] `go build ./...` clean for `common/jwtauth`, `auth-service`, `api-gateway`.
- [x] Backward compatible: a JWT minted before this change (no `role` claim) still validates, with
      `Identity.Role` simply empty — not an error.

## gitnexus

Run in this session (2026-09-09) before editing:
`impact({target:"Claims", direction:"upstream", repo:"orca", file_path:"backend-go/common/jwtauth/jwtauth.go",
summaryOnly:true})` → **risk HIGH**, impactedCount 5 (3 direct: `Sign`/`VerifyWithKey`/`Verify` in
`common/jwtauth`; indirect hits in `httpgateway` and `usecase` modules), 0 affected execution flows. HIGH is
flagged purely by `Claims`' fan-out as a shared JWT payload type — this task only adds a field
(`omitempty`, backward compatible), it does not change any of `Claims`' existing fields or the
`Sign`/`Verify`/`VerifyWithKey` signatures. `detect_changes({scope:"compare", base_ref:"main"})` after
landing (run jointly for all 7 Wave-1 tasks) confirms **risk low**, 0 affected processes.

## Blocking

None. TASK-BE-005 (regression tests) depends on this task **and** TASK-BE-003 both landing.
