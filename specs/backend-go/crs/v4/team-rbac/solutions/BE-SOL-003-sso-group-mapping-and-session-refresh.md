# BE-SOL-003: SSO group→role mapping (OIDC/GitHub) + session refresh RPC

> **🔲 Proposed — not implemented.**

**CR:** [CR-RBAC-003](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-003-sso-group-role-mapping-and-token-refresh.md)
**Service:** auth-service (`internal/adapter/oauth`, `internal/usecase`,
`internal/domain`) + api-gateway (`/auth/refresh` route)
**Depends on:** [BE-SOL-002](./BE-SOL-002-caller-role-claim-propagation.md)
(role model must be final — this CR maps SSO groups to the same 2-tier
`user`/`admin` global role BE-SOL-002 confirms, not a 3rd tier).

---

## 1. Problem (confirmed)

`VerifiedSsoIdentity` (`backend-go/services/auth-service/internal/usecase/ports.go:201-207`)
is exactly `{Provider, Subject, Email, EmailVerified, Name}` — confirmed no
`Groups` field. `oidc.go`'s `ExchangeAndVerify`
(`internal/adapter/oauth/oidc.go:95-160`) decodes `oidcUserInfo{Subject,
Email, EmailVerified, Name}` from the userinfo endpoint response — confirmed
it does not request or parse a `groups` claim anywhere. `github.go` was not
re-read in full this pass (budget) but the CR's original audit (confirmed
consistent with `VerifiedSsoIdentity`'s single shared struct) already
established it doesn't call GitHub's org/team membership endpoints either.

`domain.Session` (`backend-go/services/auth-service/internal/domain/session.go:29-36`)
is `{TokenHash, UserID, TenantID, CreatedAt, ExpiresAt, RevokedAt}` — no
refresh-token fields, confirmed. `IssueServiceToken`'s doc comment
(`adapter/grpc/server.go:137-139`) confirms "the fuller
IssueToken/RefreshToken/RevokeToken surface" isn't built — and per BE-SOL-002
§2, `IssueServiceToken` itself is a machine/CLI token mint from an
already-known `user_id`, not a session-refresh RPC.

## 2. Solution

### A. Group → role mapping

1. `internal/usecase/ports.go`:

```go
type VerifiedSsoIdentity struct {
	Provider      domain.SsoProvider
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	// Groups is the IdP's group/org/team membership at login time — only
	// populated for providers this CR wires (OIDC/Keycloak via the `groups`
	// claim, GitHub via org/team membership REST calls). Empty for Google
	// (no group claim in a standard OIDC token — Directory API integration
	// is a documented, separate backlog item, not attempted here).
	Groups []string
}
```

2. `oidc.go`'s `oidcUserInfo` gains `Groups []string \`json:"groups"\`` and
   `ExchangeAndVerify` forwards it into `VerifiedSsoIdentity.Groups`. Keycloak
   ships `groups` in its userinfo response by default when the client scope
   includes it — document that the deployment's Keycloak client must have the
   `groups` mapper enabled (a config note, not a code gap).
3. `github.go`: after the existing subject/email resolution, call
   `GET /user/orgs` (authenticated with the same access token already in
   hand from the code exchange) and map each returned org's `login` into
   `Groups` as `"org:<login>"` — team-level granularity
   (`GET /orgs/{org}/teams/{team}/memberships/{username}`) is a heavier,
   N+1-shaped call per team; start with org-level only and note team-level
   as a follow-up if a customer needs finer granularity.
4. New table `auth.sso_group_role_mapping`
   (`backend-go/services/auth-service/migrations/0004_sso_group_role_mapping.up.sql`
   — coordinate the migration number with BE-SOL-005's `0004_audit_outcome_and_ip`;
   whichever lands first takes `0004`, the other becomes `0005`):

```sql
CREATE TABLE auth.sso_group_role_mapping (
    id          UUID PRIMARY KEY,
    tenant_id   UUID NOT NULL,
    provider    TEXT NOT NULL,           -- domain.SsoProvider values
    group_name  TEXT NOT NULL,           -- e.g. "orca-admins" (OIDC) or "org:my-company" (GitHub)
    role        TEXT NOT NULL CHECK (role IN ('user', 'admin')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, provider, group_name)
);
ALTER TABLE auth.sso_group_role_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth.sso_group_role_mapping
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

   A real table (not env/config) per the CR's own preference for "quản lý
   qua 1 RPC" over static config — this also makes mapping editable by
   tenant admins without a redeploy, consistent with `AccessPolicy`'s own
   DB-backed, admin-editable model. New RPCs `UpdateSsoGroupMapping`/
   `ListSsoGroupMapping` on `AuthService`, gated by `requireAdminActor` (same
   pattern every other admin-console usecase in this service already uses).

5. `LoginOrProvisionSsoUser` (`internal/usecase/login_or_provision_sso_user.go`,
   not re-read in full this pass — verify its exact structure before
   implementing): add a role-resolution step that runs **only on first
   provisioning** (`domain.NewUser` call path, not the returning-identity
   login path):

```go
// resolveRoleFromGroups maps identity.Groups against
// sso_group_role_mapping, returning the highest-privilege matching role
// (admin > user), or domain.RoleUser if no group matches. Called ONLY when
// provisioning a brand-new user — see this function's own doc comment for
// why an existing user's role is never touched here.
func resolveRoleFromGroups(ctx context.Context, mapping SsoGroupRoleMappingRepository, tenantID string, identity VerifiedSsoIdentity) (domain.Role, error) {
	rows, err := mapping.ListForProvider(ctx, tenantID, identity.Provider)
	if err != nil {
		return domain.RoleUser, err // fail closed to the least-privileged role, never fail closed to admin
	}
	role := domain.RoleUser
	for _, g := range identity.Groups {
		if r, ok := matchGroup(rows, g); ok && r == domain.RoleAdmin {
			role = domain.RoleAdmin
			break
		}
	}
	return role, nil
}
```

   For a **returning** user, this CR's explicit security decision (already
   in the CR text, re-confirmed here as correct and worth preserving
   verbatim): only **upgrade** role from group membership on subsequent
   logins too (an admin who removed themselves from `orca-admins` in the IdP
   keeps their manually-granted admin role until an actual admin revokes it
   via `UpdateUserRole`) — never auto-downgrade. Implementation: on every SSO
   login (not just first-provision), compute the group-implied role; if
   it's `admin` and the stored user's role is currently `user`, call
   `UpdateUserRole` to upgrade; if the group-implied role is `user` but the
   stored role is `admin`, do nothing. Comment this decision at the call
   site — it's a deliberate anti-lockout security choice, not an oversight.

### B. Session refresh

1. `domain/session.go`:

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

2. New RPC `RefreshSession(refresh_token) → {session_token, expires_at}` on
   `AuthService`. Usecase `RefreshSession`:
   - Hash the presented refresh token, look up by `RefreshTokenHash`.
   - Reject (403, not a generic error) if not found, already revoked, or
     `RefreshExpiresAt` has passed.
   - **Rotate**: revoke the old session row, issue a brand-new session (new
     `TokenHash` + new `RefreshTokenHash`) — same reuse-detection principle
     `auth-service.md` §9 already documents for the (not-yet-built)
     mobile/CLI refresh-token family; applying it here for consistency even
     though this is browser-session refresh, not JWT refresh.
   - Return the new opaque session token; `api-gateway` sets it as the
     `orca_session` cookie again (same `Secure`/`HttpOnly`/`SameSite=Strict`
     posture `Login` already uses).
3. `api-gateway`: `POST /auth/refresh` in `auth_routes.go`, mirroring the
   existing `/auth/local` login route's cookie-setting shape exactly (reuse
   whatever helper already sets the session cookie on `Login`'s response —
   verify its exact name before implementing, not re-read this pass).
4. Explicitly **not** in scope (per the CR, re-confirmed correct): storing or
   refreshing the upstream IdP's own OAuth `refresh_token` — this is purely
   Orca's own session lifecycle.

## 3. Files to change

| File | Change |
|---|---|
| `backend-go/services/auth-service/internal/usecase/ports.go` | `VerifiedSsoIdentity.Groups`; new `SsoGroupRoleMappingRepository` port |
| `backend-go/services/auth-service/internal/adapter/oauth/oidc.go` | Read `groups` claim from userinfo |
| `backend-go/services/auth-service/internal/adapter/oauth/github.go` | Read `GET /user/orgs`, map to `"org:<login>"` groups |
| `backend-go/services/auth-service/internal/usecase/login_or_provision_sso_user.go` | Role resolution from groups (provision + upgrade-only on return) |
| `backend-go/services/auth-service/migrations/000X_sso_group_role_mapping.{up,down}.sql` | New table |
| `backend-go/services/auth-service/internal/usecase/update_sso_group_mapping.go`, `list_sso_group_mapping.go` (new) | Admin-gated CRUD on the mapping table |
| `backend-go/services/auth-service/internal/domain/session.go` | `RefreshTokenHash`/`RefreshExpiresAt` fields |
| `backend-go/services/auth-service/internal/usecase/refresh_session.go` (new) | Rotation + reuse-detection logic |
| `backend-go/proto/orca/auth/v1/auth.proto` | `RefreshSession`, `UpdateSsoGroupMapping`, `ListSsoGroupMapping` RPCs |
| `backend-go/services/auth-service/internal/adapter/grpc/server.go` | New RPC handlers |
| `backend-go/services/api-gateway/internal/adapter/httpgateway/auth_routes.go` | `POST /auth/refresh` |
| `docs/features/F32-team-rbac.md` | Note Google Workspace group mapping remains unsupported (documented limitation, not silently dropped) |

## 4. Out of scope

- SAML — BE-SOL-007.
- Google Workspace Directory API group mapping.
- Renewing the upstream IdP's own OAuth token.
- GitHub team-level (as opposed to org-level) group granularity — noted as a
  possible follow-up, not built in this pass.

## 5. Tests

- `oidc_test.go`: `ExchangeAndVerify` parses `groups` from userinfo when
  present; empty/absent `groups` claim doesn't error (backward compatible
  with IdPs that don't send it).
- `github_test.go`: org membership call populates `Groups` as `"org:<login>"`;
  a GitHub API failure for the orgs call degrades to empty `Groups` (login
  still succeeds) rather than failing the whole SSO flow — organizational
  membership is an enhancement, not a login precondition.
- `login_or_provision_sso_user_test.go`: extend the existing test file (it
  already has `TestLoginOrProvisionSsoUser_CreatesNewUser`,
  `TestLoginOrProvisionSsoUser_ReturningIdentity_LogsInDirectly`, etc. —
  confirmed via `codegraph_explore`) with:
  - New user, group maps to `admin` → provisioned as `admin`.
  - Returning `user`-role account whose current IdP groups now map to
    `admin` → upgraded.
  - Returning `admin`-role account (manually granted) whose IdP groups no
    longer include an admin-mapped group → role unchanged (regression guard
    for the anti-lockout decision).
- `refresh_session_test.go` (new): valid refresh rotates and returns a new
  session; expired/revoked/reused refresh token is rejected with a
  distinguishable error; reuse of an already-rotated-away refresh token
  revokes the whole session (not just denies the one request).

## 6. Impact analysis (gitnexus)

Not run with numeric results in this pass for the specific symbols this
solution touches (`VerifiedSsoIdentity`, `LoginOrProvisionSsoUser`,
`domain.Session`) — `codegraph_explore`'s blast-radius scan already surfaced
their direct callers (12 for `VerifiedSsoIdentity`, all within
`auth-service`'s own `oauth`/`usecase` packages and their tests — no
cross-service consumer). **Run `impact({target:"VerifiedSsoIdentity", direction:"upstream"})`
and `impact({target:"domain.Session", direction:"upstream", file_path:"backend-go/services/auth-service/internal/domain/session.go"})`
immediately before implementing**, per the repo's mandatory rule — both are
expected to be LOW risk (auth-service-internal, no other service imports
either type directly, confirmed by `codegraph_explore`'s "callers" lists
showing only `auth-service` files).

## 7. Relation to CR-RBAC-002/CR-RBAC-007

This CR should land after BE-SOL-002 (role model finality) — group→role
mapping targets the confirmed 2-tier global role, not a 3rd tier. BE-SOL-007
(SAML) is designed to reuse this CR's `Groups []string` extension point on
`VerifiedSsoIdentity` and the same `sso_group_role_mapping` table (SAML
attribute-based group equivalents), so keep `VerifiedSsoIdentity.Groups` and
the mapping table's shape provider-agnostic (already is — `provider` is a
column, not a separate table per provider).
