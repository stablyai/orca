# BE-SOL-002: Propagate the caller's global role into `callerGlobalRole` (both auth paths)

> **🔲 Proposed — not implemented.** This document is a solution spec only; no
> production code has been changed as part of writing it.

**CR:** [CR-RBAC-002](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-002-unify-role-model-and-propagate-claims.md)
**Service:** api-gateway (auth path) + project-service (consumer) + common/jwtauth (shared)
**Depends on:** none — independent of the other 6 CRs; CR-RBAC-001 (Admin UI
cutover) and CR-RBAC-003 (SSO group mapping) both assume this CR's role model
decision is final.

---

## 1. Problem

`project-service`'s `callerGlobalRole` (`backend-go/services/project-service/internal/usecase/authorization.go:57-59`)
hard-codes `return ""`. `project.rego`/`repo.rego` both have a "global admin
override" branch (`input.caller_global_role == "admin"` in
`backend-go/policy/orca-authz/project.rego:35-37`) that is correct and
covered by `opa test` but **structurally unreachable from Go** — a global
admin who isn't also a project member or repo functional-role holder cannot
manage that project/repo through `project-service`'s RPCs today, contrary to
F32's "admin: full access to all projects/servers" and contrary to the
comment already baked into `project.rego` describing that branch's intent.

## 2. Verified: the propagation plumbing already exists for the cookie/session path — only 3 things are missing

This is the most important finding of this pass. `codegraph_explore` traced
the full call path end-to-end and found that **api-gateway → project-service
role propagation is already wired for session-cookie logins**:

```
authclient.SessionValidator.ValidateToken   (api-gateway/internal/adapter/authclient/session_validator.go:51-61)
  → resp.GetUser().GetRole() → roleString() → wscompat.Identity{..., Role: "admin"|"user"}
httpgateway.authMiddleware                   (api-gateway/internal/adapter/httpgateway/middleware.go:50-72)
  → cookieValidator.ValidateCookie(...) → withIdentity(ctx, usecase.Identity{..., Role: id.Role})
grpc.AttachIdentity                          (api-gateway/internal/adapter/grpc/dial.go:39-45)
  → metadata.AppendToOutgoingContext(ctx, grpcmw.MetadataRole, id.Role)   // "x-orca-role"
grpcmw.TenantExtractionInterceptor           (common/grpcmw/grpcmw.go:50-66)
  → md.Get(MetadataRole) → ctx = tenant.WithRole(ctx, v[0])              // runs inside project-service's own process
project-service's requireProjectAccess/requireRepoAccess
  → callerGlobalRole(ctx) → hard-coded ""                                 // <-- THE ONLY BROKEN LINK
```

`common/tenant/tenant.go`'s `WithRole`/`Role` (added under CR-DS-006 Phase 2,
`tenant.go:39-49,63-72`) and `common/grpcmw/grpcmw.go`'s `MetadataRole`
(`"x-orca-role"`, `grpcmw.go:29-34`) are **not gaps** — they were built and
wired specifically to close this exact class of gap, and
`grpcmw_test.go`/`tenant_test.go` already cover them (`TestTenantExtractionInterceptor_AttachesRoleWhenPresent`,
`TestRole_RoundTrips`, etc.). What's missing is only:

1. **`callerGlobalRole` itself never reads `tenant.Role(ctx)`** — the one
   line this CR's title promises.
2. **The bearer-JWT auth path never populates `Identity.Role` in the first
   place** (confirmed: `usecase.Identity.Role`'s doc comment at
   `validate_identity.go:18-24` says so explicitly, and `AuthValidator.Validate`
   at `validate_identity.go:77-105` returns `Identity{TenantID: ..., UserID: ...}`
   with no `Role` field set — because `jwtauth.Claims`
   (`common/jwtauth/jwtauth.go:28-31`) has no `Role` field to read it from).
   Once `Identity.Role` is populated by either path, `AttachIdentity`/
   `TenantExtractionInterceptor` already forward it — **no new plumbing is
   needed for the bearer path beyond adding the claim itself.**
3. No regression test exercises "global admin, no project membership, calling
   via project-service" for either auth path.

**Scope note on the bearer-JWT path**: verified there is currently no
browser/mobile "login → bearer JWT" flow in production yet — the only real
JWT-minting RPC is `IssueServiceToken` (`auth-service/internal/usecase/issue_service_token.go`),
whose own doc comment says the "fuller IssueToken/RefreshToken/RevokeToken
surface" isn't built (that gap is CR-RBAC-003 §B). So today, the practical,
live-traffic fix is item 1 (cookie path); item 2 is still worth doing now
(cheap, and it's the same `Identity.Role` field every other code path already
respects) so the bearer path doesn't silently regress once CR-RBAC-003 ships
real user-facing token issuance.

## 3. Solution

### A. `project-service`: read the role that's already in context

`backend-go/services/project-service/internal/usecase/authorization.go`:

```go
// callerGlobalRole resolves the acting user's system-wide role for
// project.rego's admin-override branch, from the role claim api-gateway
// attaches via grpcmw.MetadataRole (common/tenant.WithRole) — see
// common/tenant.Role's doc comment for the fail-closed contract: an absent
// claim (ok==false) is treated as "", never as an implicit allow.
func callerGlobalRole(ctx context.Context) string {
	role, _ := tenant.Role(ctx)
	return role
}
```

No signature change — every one of `callerGlobalRole`'s 2 direct callers
(`requireProjectAccess`, `requireRepoAccess`) is unaffected mechanically;
only the *value* they now pass to `opa.Decision`/`opa.RepoDecision` changes
for the caller-is-global-admin case.

### B. `jwtauth.Claims` + `IssueServiceToken` + `AuthValidator`: give the bearer path a claim to read

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

2. `backend-go/services/auth-service/internal/usecase/issue_service_token.go`'s
   `Execute` already loads `user` via `uc.users.GetUserByID` — add one field
   to the `claims` literal:

```go
claims := jwtauth.Claims{
	Claims: jwt.Claims{ /* unchanged */ },
	TenantID: user.TenantID,
	Role:     string(user.Role),
}
```

3. `backend-go/services/api-gateway/internal/usecase/validate_identity.go`'s
   `Validate`:

```go
if claims.TenantID == "" || claims.Subject == "" {
	return Identity{}, ErrMissingIdentityClaims
}
return Identity{TenantID: claims.TenantID, UserID: claims.Subject, Role: claims.Role}, nil
```

Update the `Identity.Role` doc comment (currently says the bearer path never
populates it) and `common/tenant.Role`'s doc comment (currently says "only
the cookie/session path does") to reflect the fix — both comments are
load-bearing documentation of a gap this CR closes.

### C. Regression test: both auth paths, global admin, no membership

New table-driven test in `project-service/internal/usecase/authorization_test.go`
(create if it doesn't exist — verify first, since the package currently has
no dedicated test file for `authorization.go` per the codegraph blast-radius
scan: "⚠️ no covering tests found" on both `requireProjectAccess` and
`requireRepoAccess`):

```go
func TestRequireProjectAccess_GlobalAdminBypassesMembership(t *testing.T) {
	ctx := tenant.WithUserID(context.Background(), "admin-user")
	ctx = tenant.WithRole(ctx, "admin")
	membership := &fakeMembershipRepo{err: domain.ErrMembershipNotFound}
	opa := &fakeOPAClient{} // real project.rego semantics via a small in-memory stub, or the real Evaluator against the bundle
	err := requireProjectAccess(ctx, membership, opa, "proj-1", projectActionOwnerOnly)
	require.NoError(t, err)
}

func TestRequireProjectAccess_NoRoleClaimStaysDeny(t *testing.T) {
	// tenant.WithRole never called — Role(ctx) returns ok=false — must NOT
	// be silently treated as admin.
}
```

Mirror both cases for `requireRepoAccess`. If the fake `OPAClient` doesn't
already evaluate real Rego, prefer wiring these against the real
`opaclient.Client` + `policy.Evaluator` pointed at the checked-in bundle
(`backend-go/policy/orca-authz`) — this is the one place a fake risks masking
exactly the bug this CR fixes (a fake that always returns `true` would pass
even with the old hard-coded `""`).

## 4. Files to change

| File | Change |
|---|---|
| `backend-go/services/project-service/internal/usecase/authorization.go` | `callerGlobalRole` reads `tenant.Role(ctx)` instead of hard-coding `""`; update its doc comment |
| `backend-go/common/jwtauth/jwtauth.go` | Add `Role string` to `Claims` |
| `backend-go/services/auth-service/internal/usecase/issue_service_token.go` | Set `Role: string(user.Role)` in the minted claims |
| `backend-go/services/api-gateway/internal/usecase/validate_identity.go` | `Validate` returns `Identity{..., Role: claims.Role}`; update `Identity.Role`'s doc comment |
| `backend-go/common/tenant/tenant.go` | Update `Role`'s doc comment (no longer "bearer path never populates this") |
| `backend-go/services/project-service/internal/usecase/authorization_test.go` (new, if absent — verify) | Global-admin-bypasses-membership + no-claim-stays-deny, for both `requireProjectAccess` and `requireRepoAccess` |
| `docs/features/F32-team-rbac.md` | Update the role-model table per the CR's acceptance criteria (global 2-tier `user`/`admin`, repo-scoped 3-tier `developer`/`lead`/`admin`) |

## 5. Out of scope

- Adding a third global role ("lead" as a global role) — F32/CR-RBAC-002
  §A already decided against this; `RepoRole` (`repo.rego`) is where "lead"
  lives, unchanged by this solution.
- `annotation-service`/`task-service`: verified via `codegraph_explore` that
  `annotation-service`'s `OPAClient.Decision` (`annotation-service/internal/adapter/opaclient/client.go:36`)
  takes `actor_role` as a parameter the same way, and `task-service`'s
  `Decision` (`task-service/internal/adapter/opaclient/client.go:53`) takes
  `level`/`action`/`tenantID` with no caller-role parameter at all today — a
  full audit of every service's own `callerGlobalRole`-equivalent is a
  separate, larger pass; this CR fixes the one call site CR-RBAC-002
  explicitly names (project-service) and documents that the same fix pattern
  (read `tenant.Role(ctx)`, don't hard-code) applies wherever another service
  grows an equivalent stub.
- Building the full user-facing `IssueToken`/`RefreshToken` surface —
  CR-RBAC-003 §B.
- The frontend `OrcaUserRole` type change (drop `'lead'` as a global role) —
  listed in the CR's "Changes Required" table but is a `frontend/` change,
  out of scope for this backend-go-only solution set.

## 6. Tests

- `project-service/internal/usecase/authorization_test.go`: the 4 cases in
  §3.C (2 functions × {admin bypass, no-claim deny}).
- `common/jwtauth`: round-trip test that `Sign` → `Verify`/`VerifyWithKey`
  preserves `Claims.Role` (mirrors the existing `TenantID` round-trip
  coverage implied by `Claims`'s current shape).
- `auth-service/internal/usecase/issue_service_token_test.go`: extend
  `TestIssueServiceToken_SucceedsForExistingUser` (or add a sibling) to
  assert the minted JWT's `role` claim matches `user.Role`.
- `api-gateway/internal/usecase/validate_identity_test.go`: extend to assert
  `Validate` returns `Identity.Role` populated from a JWT carrying a `role`
  claim, and empty (not an error) when the claim is absent (backward
  compatibility with tokens minted before this change).
- Integration-shaped test (either at the `authorization_test.go` level with
  a real `policy.Evaluator`, or a new `project-service` gRPC-adapter test):
  cookie-path identity with `role=admin` and no project membership
  successfully calls an owner-gated RPC (e.g. `UpdateProject`).

## 7. Impact analysis (gitnexus, run before editing)

| Symbol | Direction | Risk | Impacted | Note |
|---|---|---|---|---|
| `callerGlobalRole` (`project-service/internal/usecase/authorization.go:57`) | upstream | **MEDIUM** | 30 (2 direct, module `Usecase`) | Confirmed by `impact()` this pass. The 30 are every usecase transitively reachable through `requireProjectAccess`/`requireRepoAccess` (both direct callers) — none of their signatures change, only the value `callerGlobalRole` returns for an actor whose role claim is `"admin"`. Behavior change is strictly additive (a previously-denied global-admin-without-membership call now succeeds) — no previously-allowed call becomes denied. |
| `WithRole` (`common/tenant/tenant.go:47`) | upstream | **CRITICAL** | 18 (1 direct, 9 processes across auth/project/infra-fleet/git-gateway/tenant/task/workflow/scm-integration/issue-tracking-service `main.go`'s `run`) | **Not modified by this solution** — `WithRole`'s signature and behavior are untouched; this CR only adds two new *call sites* that populate `Identity.Role` before it reaches `AttachIdentity`→`TenantExtractionInterceptor`→`WithRole`'s existing call site. Flagged here per the repo's CRITICAL-risk warning rule: the high fan-out is because `WithRole` is a shared primitive every service's gRPC interceptor chain already depends on (`grpcmw.ChainUnary`) — it is **not** evidence that this solution's actual edits (a 2-line function body + 1 new struct field + 2 field assignments) are risky. No other service's behavior changes unless it starts reading `tenant.Role(ctx)` itself. |

**Warning per CLAUDE.md**: `WithRole`'s own upstream impact is CRITICAL by
fan-out, so before merging, run `detect_changes({scope:"compare", base_ref:"main"})`
and confirm the diff only touches `jwtauth.Claims`, `IssueServiceToken`,
`AuthValidator.Validate`, and `project-service/authorization.go` — if the
diff shows `tenant.go`'s `WithRole`/`Role` functions themselves changed,
stop and re-review, since that would be touching the CRITICAL-risk shared
primitive rather than one of its call sites.
