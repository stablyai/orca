package usecase

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// LoginOrProvisionSsoUserOutput mirrors LoginOutput — SSO and local login
// hand the caller (api-gateway) the identical shape, since both set the
// same orca_session cookie the same way.
type LoginOrProvisionSsoUserOutput struct {
	SessionToken string
	// RefreshToken — see LoginOutput.RefreshToken's doc comment; SSO login
	// gets one for the same reason local login does (TASK-BE-012).
	RefreshToken string
	User         domain.User
}

// LoginOrProvisionSsoUser turns a provider-verified identity into a
// session, auto-provisioning a User the first time a given IdP identity is
// ever seen. Deliberately separated from the OAuth/token-exchange mechanics
// (see complete_sso_login.go) so this — the actual account-linking policy —
// is testable with zero HTTP mocking.
//
// Account-collision policy, checked in this order:
//  1. An auth.sso_identities row already links (Provider, Subject) to a
//     user -> this is a returning SSO login. No email lookup at all; the
//     identity row alone is the login key from here on (EmailAtLink is an
//     audit trail, never re-read for this decision — see domain.SsoIdentity's
//     doc comment).
//  2. No identity row, but auth.users already has a row for this email AND
//     the IdP reports the email verified -> auto-link: this is the "admin
//     pre-created a User row, the employee's first login is via SSO"
//     pattern, a first-class supported flow in this system (every account
//     here is tenant-provisioned, not public self-signup), not an edge
//     case.
//  3. No identity row, an existing local account with this email, but the
//     IdP does NOT report the email verified -> reject
//     (AUTH_SSO_EMAIL_UNVERIFIED_COLLISION). Auto-linking on an unverified
//     email is a straightforward account-takeover vector (attacker
//     registers an IdP identity using a victim's email at a lax IdP). Never
//     silently create a duplicate account either — this needs a human
//     (admin) to resolve out of band (e.g. UpdateUserRole-style manual
//     intervention via direct DB access is the only path today — no
//     dedicated admin console action exists yet, see README "Known gaps").
//  4. No identity row, no existing account with this email, but the IdP
//     does NOT report the email verified -> reject
//     (AUTH_SSO_EMAIL_NOT_VERIFIED), same as step 3 and for the identical
//     reason: silently provisioning a brand-new account bound to an
//     unverified email is itself an account-takeover vector, not just the
//     collision case. Without this check, an attacker could register an
//     SSO identity against a victim's real email at a lax/unverified IdP
//     *before* the victim ever signs up — squatting that email in
//     auth.users — and when the real victim later logs in with a
//     genuinely verified SSO identity for the same email, step 2 would
//     auto-link the victim's verified login into the attacker's
//     pre-existing (attacker-controlled) account. Requiring verification
//     on the FIRST creation of an email closes that hole: an unverified
//     identity can never claim an email at all, verified or not.
//  5. No identity row, no existing account, and the IdP DOES report the
//     email verified -> brand-new user, the CR-DS-008 "first login, no
//     department yet" case. Role defaults to domain.RoleUser, upgraded to
//     domain.RoleAdmin only if the IdP's group membership maps to admin via
//     resolveRoleFromGroups (CR-RBAC-003) — SSO still never auto-admins on
//     its own authority, only by an admin's explicit group-mapping config.
type LoginOrProvisionSsoUser struct {
	users      UserRepository
	identities SsoIdentityRepository
	sessions   SessionRepository
	audit      AuditRepository
	hasher     PasswordHasher
	tenants    TenantResolver
	mapping    SsoGroupRoleMappingRepository
	clock      Clock
	sessionTTL time.Duration
}

func NewLoginOrProvisionSsoUser(
	users UserRepository,
	identities SsoIdentityRepository,
	sessions SessionRepository,
	audit AuditRepository,
	hasher PasswordHasher,
	tenants TenantResolver,
	mapping SsoGroupRoleMappingRepository,
	clock Clock,
	sessionTTL time.Duration,
) *LoginOrProvisionSsoUser {
	if sessionTTL <= 0 {
		sessionTTL = DefaultSessionTTL
	}
	return &LoginOrProvisionSsoUser{
		users: users, identities: identities, sessions: sessions, audit: audit,
		hasher: hasher, tenants: tenants, mapping: mapping, clock: clock, sessionTTL: sessionTTL,
	}
}

func (uc *LoginOrProvisionSsoUser) Execute(ctx context.Context, in VerifiedSsoIdentity) (LoginOrProvisionSsoUserOutput, error) {
	if in.Provider == "" || in.Subject == "" {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_SSO_MISSING_IDENTITY", "provider and subject are required", nil)
	}
	if in.Email == "" {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_SSO_MISSING_EMAIL", "the identity provider did not return an email address", nil)
	}

	// Step 1: returning SSO identity -> log straight in, no email logic.
	identity, err := uc.identities.FindByProviderSubject(ctx, in.Provider, in.Subject)
	if err == nil {
		user, err := uc.users.GetUserByID(ctx, identity.UserID)
		if err != nil {
			return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_LINKED_USER_MISSING", "the user linked to this sso identity could not be loaded", err)
		}
		if !user.IsActive {
			return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_ACCOUNT_DEACTIVATED", "account is deactivated", nil)
		}
		// Group-implied role is re-evaluated on every returning login, not
		// just first provisioning, so a group added to orca-admins AFTER a
		// user's first login still upgrades them. Deliberate anti-lockout
		// asymmetry: only ever UPGRADE (user -> admin) here. If the
		// group-implied role is user but the stored role is admin, do
		// nothing — an admin who removed themselves from orca-admins in the
		// IdP keeps their manually-granted admin role until an actual admin
		// revokes it via UpdateUserRole. This is deliberate, not an
		// oversight.
		if role, rerr := resolveRoleFromGroups(ctx, uc.mapping, user.TenantID, in); rerr == nil && role == domain.RoleAdmin && user.Role == domain.RoleUser {
			if upgraded, err := uc.users.UpdateUserRole(ctx, user.ID, domain.RoleAdmin); err == nil {
				user = upgraded
			}
		}
		return uc.issueSession(ctx, user, in.Provider, "user.sso_login", func(now time.Time) {
			_ = uc.identities.TouchLastLogin(ctx, identity.ID, now)
		})
	}
	if !errors.Is(err, ErrSsoIdentityNotFound) {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_IDENTITY_LOOKUP_FAILED", "failed to look up sso identity", err)
	}

	// Step 2/3: no identity row yet — check for an existing local account
	// with this email.
	existingUser, _, err := uc.users.GetUserByEmail(ctx, in.Email)
	if err == nil {
		if !in.EmailVerified {
			return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_SSO_EMAIL_UNVERIFIED_COLLISION", "an account with this email already exists and the identity provider did not verify it; ask an admin to link your account", nil)
		}
		if !existingUser.IsActive {
			return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_ACCOUNT_DEACTIVATED", "account is deactivated", nil)
		}
		now := uc.clock.Now()
		newIdentity, ierr := domain.NewSsoIdentity(uuid.NewString(), existingUser.ID, existingUser.TenantID, in.Provider, in.Subject, in.Email, now)
		if ierr != nil {
			return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_INVALID_IDENTITY", ierr.Error(), ierr)
		}
		if err := uc.identities.Link(ctx, newIdentity); err != nil {
			return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_LINK_FAILED", "failed to link sso identity to existing account", err)
		}
		return uc.issueSession(ctx, existingUser, in.Provider, "user.sso_login_linked", nil)
	}
	if !errors.Is(err, ErrUserNotFound) {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_USER_LOOKUP_FAILED", "failed to look up user by email", err)
	}

	// Step 4: no existing account, but the IdP didn't verify the email —
	// reject rather than let an unverified identity claim (squat) it. See
	// this type's doc comment for the account-takeover scenario this
	// closes; this is NOT redundant with step 3's check above (that one
	// guards an *existing* account, this one guards email ownership at the
	// moment a NEW account would first claim it).
	if !in.EmailVerified {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_SSO_EMAIL_NOT_VERIFIED", "the identity provider did not verify this email address; verify it with your identity provider and try again, or ask an admin to create your account", nil)
	}

	// Step 5: brand-new user. Resolve which tenant it belongs to from the
	// verified email's domain, fail closed rather than guess — see
	// TenantResolver's doc comment.
	tenantID, err := uc.tenants.ResolveTenantForEmail(ctx, in.Email)
	if err != nil {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindFailedPrecondition, "AUTH_SSO_UNKNOWN_ORGANIZATION", "your organization isn't set up for SSO sign-up yet; ask an admin to register your email domain", err)
	}

	// auth.users.password_hash is NOT NULL — an SSO-only user gets a
	// bcrypt hash of a random, never-disclosed value (same pattern
	// CreateUser's auto-generated-password branch uses). This has the
	// correct side effect: a pure-SSO user simply cannot succeed at
	// /auth/local.
	randomPassword, err := generateRandomToken(24)
	if err != nil {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_PASSWORD_GEN_FAILED", "failed to provision account", err)
	}
	passwordHash, err := uc.hasher.Hash(randomPassword)
	if err != nil {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_PASSWORD_HASH_FAILED", "failed to provision account", err)
	}

	now := uc.clock.Now()
	// resolveRoleFromGroups fails closed to domain.RoleUser on a mapping
	// lookup error — never blocks brand-new provisioning, and never fails
	// closed to admin.
	role, _ := resolveRoleFromGroups(ctx, uc.mapping, tenantID, in)
	newUser, err := domain.NewUser(uuid.NewString(), tenantID, in.Email, in.Name, role, true, now)
	if err != nil {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_SSO_INVALID_USER", err.Error(), err)
	}
	createdUser, err := uc.users.CreateUser(ctx, newUser, passwordHash)
	if errors.Is(err, ErrUserAlreadyExists) {
		// Lost a race against a concurrent local CreateUser/other SSO
		// provisioning for the same email — surface as a retryable
		// collision rather than a generic 500; a retry re-enters this
		// Execute call and lands on step 2/3 instead.
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindAlreadyExists, "AUTH_SSO_USER_RACE", "an account with this email was just created; please try again", err)
	}
	if err != nil {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_USER_CREATE_FAILED", "failed to provision account", err)
	}

	newIdentity, err := domain.NewSsoIdentity(uuid.NewString(), createdUser.ID, createdUser.TenantID, in.Provider, in.Subject, in.Email, now)
	if err != nil {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_INVALID_IDENTITY", err.Error(), err)
	}
	if err := uc.identities.Link(ctx, newIdentity); err != nil {
		return LoginOrProvisionSsoUserOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SSO_LINK_FAILED", "failed to link sso identity to new account", err)
	}

	return uc.issueSession(ctx, createdUser, in.Provider, "user.sso_provisioned", nil)
}

// issueSession is the tail shared by every branch above: mint a session
// (reusing Login's own createSessionForUser helper — never duplicated),
// record provider as the user's most recent SSO login provider (best
// effort — see domain.User.SsoProvider's doc comment; a failure here must
// never fail an otherwise-successful login), append a best-effort audit
// entry, and run an optional side effect (e.g. touching
// sso_identities.last_login_at) with the same "now" instant.
func (uc *LoginOrProvisionSsoUser) issueSession(ctx context.Context, user domain.User, provider domain.SsoProvider, auditAction string, sideEffect func(now time.Time)) (LoginOrProvisionSsoUserOutput, error) {
	rawToken, rawRefreshToken, now, err := createSessionForUser(ctx, uc.sessions, uc.clock, uc.sessionTTL, user)
	if err != nil {
		return LoginOrProvisionSsoUserOutput{}, err
	}
	_ = uc.users.SetSsoProvider(ctx, user.ID, provider)
	user.SsoProvider = provider
	if sideEffect != nil {
		sideEffect(now)
	}
	if entry, err := domain.NewAuditEntry(uuid.NewString(), user.TenantID, user.ID, auditAction, user.ID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}
	return LoginOrProvisionSsoUserOutput{SessionToken: rawToken, RefreshToken: rawRefreshToken, User: user}, nil
}

// resolveRoleFromGroups maps identity.Groups against
// sso_group_role_mapping, returning the highest-privilege matching role
// (admin > user), or domain.RoleUser if no group matches. Called both when
// provisioning a brand-new user and on every returning-user login (see
// Execute's call sites) — an existing admin's role is never *downgraded*
// here, only ever upgraded; the anti-lockout asymmetry lives at the call
// site, not in this function.
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

// matchGroup reports whether group matches any row's GroupName, returning
// that row's mapped role.
func matchGroup(rows []domain.SsoGroupRoleMapping, group string) (domain.Role, bool) {
	for _, r := range rows {
		if r.GroupName == group {
			return r.Role, true
		}
	}
	return "", false
}
