// Package usecase holds auth-service's application services and the ports
// they need — defined here, implemented in internal/adapter/*, per the
// Dependency Inversion convention in
// specs/backend-go/architecture/03-clean-architecture-guidelines.md.
package usecase

import (
	"context"
	"errors"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/stablyai/orca-go/common/jwtauth"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// Sentinel errors an adapter/postgres implementation wraps (fmt.Errorf
// "...: %w") and a usecase unwraps via errors.Is, so the usecase layer can
// tell "not found"/"already exists" apart from a generic infrastructure
// failure without either layer importing the other's implementation
// package — only this shared, dependency-free set of values.
var (
	ErrUserNotFound      = errors.New("usecase: user not found")
	ErrUserAlreadyExists = errors.New("usecase: a user with this email already exists in this tenant")
	ErrSessionNotFound   = errors.New("usecase: session not found")
	ErrPolicyNotFound    = errors.New("usecase: access policy not found")
	// ErrSsoIdentityNotFound is returned when no auth.sso_identities row
	// matches a (provider, external_subject) lookup — the "this IdP
	// identity has never logged in here before" case
	// LoginOrProvisionSsoUser branches on.
	ErrSsoIdentityNotFound = errors.New("usecase: sso identity not found")
	// ErrServiceTokenNotFound is returned when no auth.issued_service_tokens
	// row matches a jti lookup — RevokeCliToken's "nothing to revoke" case.
	ErrServiceTokenNotFound = errors.New("usecase: issued service token not found")
)

// UserRepository is the persistence port for users. Implemented by
// internal/adapter/postgres against auth-service's own database — see
// specs/backend-go/architecture/05-data-architecture.md's
// database-per-service rule.
//
// GetUserByEmail and CreateUser carry the bcrypt password hash as an extra
// return/parameter rather than a field on domain.User — the hash is
// storage-layer material the Login/CreateUser usecases need but which has
// no business meaning to any other consumer of a domain.User value (see
// domain.User's doc comment).
type UserRepository interface {
	// CreateUser persists a new user together with its password hash.
	// Returns an error satisfying errors.Is(err, ErrEmailAlreadyExists) if
	// (tenant_id, email) already exists.
	CreateUser(ctx context.Context, user domain.User, passwordHash string) (domain.User, error)
	// GetUserByEmail looks up a user by email and returns its password hash
	// alongside it, for Login to verify against. The proto's LoginRequest
	// carries no tenant discriminator (see auth-service's README "Known
	// gaps"), so lookup is by email alone.
	GetUserByEmail(ctx context.Context, email string) (domain.User, string, error)
	GetUserByID(ctx context.Context, userID string) (domain.User, error)
	ListUsers(ctx context.Context, tenantID, pageToken string, pageSize int32) ([]domain.User, string, error)
	UpdateUserRole(ctx context.Context, userID string, role domain.Role) (domain.User, error)
	// SetActive flips a user's is_active flag — the admin-console
	// deactivate/reactivate operations (internal/usecase/deactivate_user.go,
	// reactivate_user.go). Idempotent: setting an already-matching value is
	// not an error.
	SetActive(ctx context.Context, userID string, active bool) error
	// HasAnyUsers reports whether ANY row exists in the users table,
	// across every tenant — deliberately not tenant-scoped, since it
	// exists only for Bootstrap's "is this a completely fresh deployment"
	// check (internal/usecase/bootstrap.go), which by definition runs
	// before any tenant context exists to scope by.
	HasAnyUsers(ctx context.Context) (bool, error)
	// Count returns the total number of users across every tenant — backs
	// GetAdminStats's total_users field (internal/usecase/get_admin_stats.go).
	Count(ctx context.Context) (int32, error)
	// SetSsoProvider records provider as the given user's most recent SSO
	// login provider — see domain.User.SsoProvider's doc comment. Called
	// by LoginOrProvisionSsoUser on every successful SSO login, never by
	// local-password Login.
	SetSsoProvider(ctx context.Context, userID string, provider domain.SsoProvider) error
}

// SessionRepository is the persistence port for sessions. Only the SHA-256
// hash of a session token is ever passed across this interface — see
// domain.Session's doc comment.
type SessionRepository interface {
	CreateSession(ctx context.Context, session domain.Session) error
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (domain.Session, error)
	RevokeSession(ctx context.Context, tokenHash string, revokedAt time.Time) error
	// ListForUser returns every session (revoked or not, expired or not)
	// for userID — the admin-console session-inspection view
	// (internal/usecase/list_sessions_for_user.go), which needs the full
	// history, not just currently-valid sessions.
	ListForUser(ctx context.Context, userID string) ([]domain.Session, error)
	// RevokeAllForUser force-revokes every currently-unrevoked session for
	// userID and returns how many were revoked — the admin-console "kill
	// all sessions" operation (internal/usecase/force_revoke_all_sessions.go),
	// distinct from RevokeSession's single-token revoke.
	RevokeAllForUser(ctx context.Context, userID string, revokedAt time.Time) (int32, error)
	// CountActive returns the number of currently-valid (unrevoked,
	// unexpired) sessions across every tenant — backs GetAdminStats's
	// active_sessions field.
	CountActive(ctx context.Context, now time.Time) (int32, error)
	// GetSessionByRefreshTokenHash looks up a session by its refresh token's
	// hash — RefreshSession's lookup (CR-RBAC-003/TASK-BE-011). Returns an
	// error satisfying errors.Is(err, ErrSessionNotFound) when no row has
	// this refresh_token_hash (never populated, or never issued one).
	GetSessionByRefreshTokenHash(ctx context.Context, refreshTokenHash string) (domain.Session, error)
}

// ServiceTokenRepository is the persistence port for
// auth.issued_service_tokens — the revocation-list entry IssueServiceToken
// records for every CLI/service JWT it mints (CR-CLI-002/TASK-BE-CLI-005).
// Unlike SessionRepository, there is no "get by jti" method returning the
// full row for validation purposes — the JWT itself is still verified by
// signature/exp (JWKS), this port only answers "has this jti been
// revoked", kept as its own narrow IsRevoked query so api-gateway's
// per-request revocation check (usecase.AuthValidator) stays a single
// cheap lookup, not a full row fetch.
type ServiceTokenRepository interface {
	// RecordIssuedToken persists a new issued-token row — called once, by
	// IssueServiceToken, right after a successful Sign.
	RecordIssuedToken(ctx context.Context, token domain.IssuedServiceToken) error
	// IsRevoked reports whether jti has been revoked. A jti this
	// repository has never seen (e.g. a JWT minted before this table
	// existed) reports false, not an error — see RevocationChecker's
	// (api-gateway) doc comment for why an unknown jti must never fail
	// closed here.
	IsRevoked(ctx context.Context, jti string) (bool, error)
	// Revoke marks jti revoked as of now. Returns an error satisfying
	// errors.Is(err, ErrServiceTokenNotFound) if jti has no row.
	Revoke(ctx context.Context, jti string, revokedAt time.Time) error
	// ListServiceTokensForUser returns every issued token (revoked or not,
	// expired or not) for userID, newest first — mirrors
	// SessionRepository.ListForUser's "full history" shape. Named
	// distinctly (not ListForUser) because both interfaces are implemented
	// by the same *postgres.Repository — Go methods are per-receiver-type,
	// not per-interface, so a same-named method with a different signature
	// on the same type is a compile error, not overloading.
	ListServiceTokensForUser(ctx context.Context, userID string) ([]domain.IssuedServiceToken, error)
}

// AccessPolicyRepository is the persistence port for admin-console access
// policies. Per auth-service.md:150, UpdateAccessPolicy never mutates a row
// in place — it always inserts a NEW version row, so this port has no
// "update" method, only InsertPolicyVersion, matching the append-only
// versioning contract every usecase in access_policy CRUD relies on.
type AccessPolicyRepository interface {
	// InsertPolicyVersion appends a new version row for p.ID (or the first
	// row, at version 1, if p.ID has no prior version).
	InsertPolicyVersion(ctx context.Context, p domain.AccessPolicy) error
	// GetLatestPolicy returns the highest-version row for id, or an error
	// satisfying errors.Is(err, ErrPolicyNotFound) if no version exists.
	GetLatestPolicy(ctx context.Context, id string) (domain.AccessPolicy, error)
	// ListLatestPolicies returns one row per policy id — its latest
	// version only, never every historical version.
	ListLatestPolicies(ctx context.Context, pageToken string, pageSize int32) ([]domain.AccessPolicy, string, error)
	// DeletePolicy removes every version row for id.
	DeletePolicy(ctx context.Context, id string) error
	// CountDistinctIDs returns the number of distinct policy ids (not the
	// number of version rows) — backs GetAdminStats's total_policies field.
	CountDistinctIDs(ctx context.Context) (int32, error)
}

// PolicyDataPublisher publishes a newly-versioned AccessPolicy to the OPA
// bundle registry so policy-engine instances pick up the change — per
// auth-service.md:194. Kept behind this port (rather than a concrete OPA
// bundle-registry client) so UpdateAccessPolicy compiles and is swappable
// today even though a real bundle-registry integration isn't wired in this
// scaffold yet — see internal/adapter/opaclient's README "Known gaps".
type PolicyDataPublisher interface {
	PublishPolicyChange(ctx context.Context, policy domain.AccessPolicy) error
}

// AuditRepository is the persistence port for the append-only audit log.
// There is deliberately no Update/Delete method — see domain.AuditEntry's
// doc comment.
type AuditRepository interface {
	Append(ctx context.Context, entry domain.AuditEntry) error
	// Query returns entries for tenantID at or after since, optionally
	// narrowed by actorID/action/outcome — empty string ("" for actorID/
	// action, domain.Outcome("") for outcome) means "no filter" on that
	// dimension, matching this codebase's established empty-means-no-filter
	// convention (see ListAnnotations' filePath parameter). TASK-BE-015: the
	// call sites that predate these 3 filters (QueryAuditLog's usecase) pass
	// all three empty, preserving their exact prior behavior.
	Query(ctx context.Context, tenantID string, since time.Time, actorID, action string, outcome domain.Outcome, pageToken string, pageSize int32) ([]domain.AuditEntry, string, error)
}

// PasswordHasher hashes and verifies passwords. Implemented by
// internal/adapter/bcrypt — kept behind this port so domain/ and the rest
// of usecase/ never import bcrypt directly, per auth-service.md §6.
type PasswordHasher interface {
	Hash(password string) (string, error)
	// Compare returns nil if password matches hash, a non-nil error
	// otherwise. Never distinguishes "wrong password" from other failure
	// modes in its error value in a way callers should branch on — Login
	// treats any non-nil error as invalid credentials.
	Compare(hash, password string) error
}

// Clock abstracts time.Now so session-expiry logic (Login, ValidateSession)
// is deterministically testable against fakes, per
// specs/backend-go/standards/testing-strategy.md.
type Clock interface {
	Now() time.Time
}

// SystemClock is the real Clock, wired in cmd/server/main.go.
type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now().UTC() }

// OPAClient is the authorization port requireAdminActor uses for the "is
// this actor an admin" decision — implemented by internal/adapter/opaclient
// against the shared embedded OPA evaluator (common/policy), consuming
// backend-go/policy/orca-authz/admin.rego's data.orca.authz.admin.allow
// rule. Mirrors task-service/annotation-service's own OPAClient port shape.
type OPAClient interface {
	// Decision reports whether actor is authorized as admin, per
	// admin.rego's {"actor": {"id", "role"}} input contract.
	Decision(ctx context.Context, actor domain.User) (bool, error)
}

// SsoIdentityRepository is the persistence port for auth.sso_identities.
// Implemented by internal/adapter/postgres, mirroring UserRepository's
// shape/conventions.
type SsoIdentityRepository interface {
	// FindByProviderSubject looks up the local user linked to an IdP
	// identity — the first lookup LoginOrProvisionSsoUser performs on
	// every SSO login. Returns an error satisfying errors.Is(err,
	// ErrSsoIdentityNotFound) when no row matches.
	FindByProviderSubject(ctx context.Context, provider domain.SsoProvider, externalSubject string) (domain.SsoIdentity, error)
	// Link persists a new provider/external_subject -> user_id row —
	// called once, either at brand-new-user provisioning or when an
	// existing local account is claimed via a verified-email match. See
	// login_or_provision_sso_user.go's account-collision policy.
	Link(ctx context.Context, identity domain.SsoIdentity) error
	// TouchLastLogin updates last_login_at for a returning identity —
	// best-effort bookkeeping, not part of the auth decision itself.
	TouchLastLogin(ctx context.Context, id string, at time.Time) error
}

// VerifiedSsoIdentity is what a successful provider token-exchange +
// userinfo call yields — the trust boundary LoginOrProvisionSsoUser
// operates on. EmailVerified drives the account-collision policy in
// login_or_provision_sso_user.go: only a verified email may auto-link to an
// existing local account.
type VerifiedSsoIdentity struct {
	Provider      domain.SsoProvider
	Subject       string // the IdP's stable subject (GitHub numeric id as text, or OIDC "sub")
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

// SsoExchanger performs one provider's half of the OAuth2/OIDC
// authorization-code flow: building the authorization URL the browser is
// redirected to (with PKCE), and exchanging a callback code for a verified
// identity. Mirrors scm-integration-service's OAuthExchanger shape/rationale
// — kept as its own interface so usecase/ code never imports a provider's
// HTTP client package directly.
type SsoExchanger interface {
	// AuthorizationURL builds the URL to redirect the browser to. No
	// network call — pure string construction from state/redirectURI/
	// codeChallenge (PKCE, RFC 7636 S256).
	AuthorizationURL(state, redirectURI, codeChallenge string) string
	// ExchangeAndVerify calls the provider's token endpoint for real, then
	// resolves the caller's verified identity (GitHub: GET /user +
	// /user/emails; Google/OIDC: the provider's userinfo endpoint) — see
	// internal/adapter/oauth's package doc comment for why this is one
	// userinfo-REST-call shape across all three providers rather than
	// local id_token JWT verification.
	ExchangeAndVerify(ctx context.Context, code, redirectURI, codeVerifier string) (VerifiedSsoIdentity, error)
}

// SsoExchangerRegistry resolves which SsoExchanger to use for a given
// provider — mirrors scm-integration-service's OAuthExchangerRegistry. A
// provider with no configured client_id/secret is simply absent from the
// registry; Resolve errors for it.
type SsoExchangerRegistry interface {
	Resolve(provider domain.SsoProvider) (SsoExchanger, error)
}

// SsoState is the payload carried by StartSsoLogin's opaque state token and
// recovered by CompleteSsoLogin. Unlike scm-integration-service's
// OAuthState, this carries no TenantID/UserID — SSO's Start endpoint runs
// before any session exists, so there is no caller identity yet to bind.
type SsoState struct {
	Provider     domain.SsoProvider
	RedirectURI  string
	CodeVerifier string // PKCE verifier (RFC 7636), reproduced at token-exchange time
	ExpiresAt    time.Time
}

// SsoStateCodec creates and verifies the state token exchanged during the
// SSO flow. Stateless (signed, not looked up) — api-gateway owns no
// database (see its config.go's package doc comment), so the state token
// itself must carry everything CompleteSsoLogin needs, integrity-protected
// against tampering. This also means any gateway instance can decode a
// token any other instance minted, since the HMAC secret is shared config,
// not in-memory state — required for a multi-instance deployment.
type SsoStateCodec interface {
	Encode(state SsoState) (string, error)
	// Decode verifies the token's signature and expiry, returning an error
	// for a tampered, expired, or malformed token — CompleteSsoLogin must
	// treat any Decode error as a rejected callback, never a best-effort
	// partial decode.
	Decode(token string) (SsoState, error)
}

// TenantResolver resolves which tenant a brand-new SSO-provisioned user
// belongs to, given their verified email. Implemented by
// internal/adapter/grpcclient against tenant-service's
// ResolveCompanyByEmailDomain RPC (multi-tenant: the domain half of the
// email, e.g. "vnpay.vn", must have been registered to a company via
// tenant-service's AddCompanyEmailDomain admin operation), falling back to
// the single-existing-company case for deployments that haven't registered
// any domains yet (back-compat with this service's original
// single-tenant-only design). Fails closed (an error, not a guess) when
// neither resolves — no per-login tenant discriminator beyond the email's
// own domain exists in this system (see GetUserByEmail's doc comment
// above).
type TenantResolver interface {
	ResolveTenantForEmail(ctx context.Context, email string) (tenantID string, err error)
}

// SsoGroupRoleMappingRepository is the persistence port for
// auth.sso_group_role_mapping — the admin-editable (tenant_id, provider,
// group_name) -> role table CR-RBAC-003's group->role resolution reads
// (TASK-BE-010, a later task) and UpdateSsoGroupMapping/ListSsoGroupMapping
// write/read here (TASK-BE-009).
type SsoGroupRoleMappingRepository interface {
	// Upsert inserts a new mapping row, or updates role on an existing
	// (tenant_id, provider, group_name) row — mirrors the table's own
	// UNIQUE constraint. Returns the resulting row (with its id, whether
	// newly generated or the pre-existing one).
	Upsert(ctx context.Context, m domain.SsoGroupRoleMapping) (domain.SsoGroupRoleMapping, error)
	// ListForProvider returns every mapping row for tenantID, optionally
	// narrowed to one provider — an empty provider means "every provider",
	// matching this codebase's established empty-means-no-filter convention
	// (see AuditRepository.Query's doc comment).
	ListForProvider(ctx context.Context, tenantID string, provider domain.SsoProvider) ([]domain.SsoGroupRoleMapping, error)
}

// TokenSigner is the port IssueServiceToken/GetJWKS sign and publish JWTs
// through — implemented by internal/adapter/vault against a Vault Transit
// key, kept behind this interface so this usecase package never imports
// common/secrets or Vault SDK types directly, per auth-service's other
// ports (PasswordHasher, etc.) following the same Dependency Inversion
// convention.
type TokenSigner interface {
	// Sign mints a compact-serialized RS256 JWT for claims.
	Sign(ctx context.Context, claims jwtauth.Claims) (string, error)
	// PublicJWKS returns the current+previous signing key version as an
	// RFC 7517 JWK Set, for GetJWKS to publish.
	PublicJWKS(ctx context.Context) (jose.JSONWebKeySet, error)
}
