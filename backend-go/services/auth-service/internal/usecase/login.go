package usecase

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// DefaultSessionTTL is used when no explicit TTL is configured — see
// cmd/server/main.go / internal/config.
const DefaultSessionTTL = 24 * time.Hour

// LoginInput mirrors the gRPC LoginRequest 1:1 — see
// architecture/03's note that usecase granularity mirrors today's RPC
// methods.
type LoginInput struct {
	Email    string
	Password string
}

// LoginOutput carries the raw session token — the ONLY point in the
// system's lifetime this raw value exists outside the caller's hands; from
// here on only its hash is ever seen again (domain.Session doc comment).
type LoginOutput struct {
	SessionToken string
	// RefreshToken lets api-gateway's /auth/local set an orca_refresh
	// cookie alongside orca_session, so /auth/refresh (TASK-BE-012) has
	// something to rotate from on this session's very first request — a
	// session created without one (as every session was, before this
	// change) can never be refreshed, since RefreshSession looks a session
	// up BY its refresh-token hash (CR-RBAC-003, found while wiring
	// TASK-BE-012).
	RefreshToken string
	User         domain.User
}

// Login verifies the caller's credentials, creates a new session (always a
// fresh one — never reuses a pre-auth session ID, per auth-service.md §9),
// and appends an audit entry.
type Login struct {
	users      UserRepository
	sessions   SessionRepository
	audit      AuditRepository
	hasher     PasswordHasher
	clock      Clock
	sessionTTL time.Duration
}

func NewLogin(users UserRepository, sessions SessionRepository, audit AuditRepository, hasher PasswordHasher, clock Clock, sessionTTL time.Duration) *Login {
	if sessionTTL <= 0 {
		sessionTTL = DefaultSessionTTL
	}
	return &Login{users: users, sessions: sessions, audit: audit, hasher: hasher, clock: clock, sessionTTL: sessionTTL}
}

func (uc *Login) Execute(ctx context.Context, in LoginInput) (LoginOutput, error) {
	if in.Email == "" || in.Password == "" {
		return LoginOutput{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_CREDENTIALS", "email and password are required", nil)
	}

	user, passwordHash, err := uc.users.GetUserByEmail(ctx, in.Email)
	if err != nil {
		// Deliberately the same error for "no such user" and "wrong
		// password" below — do not let Login leak which one it was.
		return LoginOutput{}, apperrors.New(apperrors.KindUnauthenticated, "AUTH_INVALID_CREDENTIALS", "invalid email or password", nil)
	}
	if !user.IsActive {
		return LoginOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_ACCOUNT_DEACTIVATED", "account is deactivated", nil)
	}
	if err := uc.hasher.Compare(passwordHash, in.Password); err != nil {
		return LoginOutput{}, apperrors.New(apperrors.KindUnauthenticated, "AUTH_INVALID_CREDENTIALS", "invalid email or password", nil)
	}

	rawToken, rawRefreshToken, now, err := createSessionForUser(ctx, uc.sessions, uc.clock, uc.sessionTTL, user)
	if err != nil {
		return LoginOutput{}, err
	}

	uc.appendAuditBestEffort(ctx, user, now)

	return LoginOutput{SessionToken: rawToken, RefreshToken: rawRefreshToken, User: user}, nil
}

// createSessionForUser mints a fresh opaque session token and persists its
// hash — the one piece of Login's original logic LoginOrProvisionSsoUser
// also needs verbatim (SSO login must produce the exact same orca_session-
// cookie-compatible session a local login does), so it's factored out here
// rather than duplicated. Returns the raw session token and raw refresh
// token (see LoginOutput's doc comment on why the session token is the only
// place THAT value ever exists outside the caller's hands — the same
// principle applies to the refresh token) and the "now" instant used, so
// callers can reuse it for their own audit entry without a second clock
// read.
//
// Every session is issued a refresh token at creation (CR-RBAC-003,
// TASK-BE-012) — RefreshSession (TASK-BE-011) looks a session up BY its
// refresh-token hash, so a session minted without one could never be
// refreshed; DefaultRefreshTokenTTL (refresh_session.go) is reused here so
// both places agree on the default lifetime.
func createSessionForUser(ctx context.Context, sessions SessionRepository, clock Clock, sessionTTL time.Duration, user domain.User) (rawToken, rawRefreshToken string, now time.Time, err error) {
	rawToken, err = generateRandomToken(32)
	if err != nil {
		return "", "", time.Time{}, apperrors.New(apperrors.KindInternal, "AUTH_TOKEN_GEN_FAILED", "failed to generate session token", err)
	}
	rawRefreshToken, err = generateRandomToken(32)
	if err != nil {
		return "", "", time.Time{}, apperrors.New(apperrors.KindInternal, "AUTH_TOKEN_GEN_FAILED", "failed to generate refresh token", err)
	}

	now = clock.Now()
	session, err := domain.NewSession(domain.HashSessionToken(rawToken), user.ID, user.TenantID, now, now.Add(sessionTTL))
	if err != nil {
		return "", "", time.Time{}, apperrors.New(apperrors.KindInternal, "AUTH_INVALID_SESSION", err.Error(), err)
	}
	session.RefreshTokenHash = domain.HashSessionToken(rawRefreshToken)
	session.RefreshExpiresAt = now.Add(DefaultRefreshTokenTTL)
	if err := sessions.CreateSession(ctx, session); err != nil {
		return "", "", time.Time{}, apperrors.New(apperrors.KindInternal, "AUTH_SESSION_CREATE_FAILED", "failed to create session", err)
	}
	return rawToken, rawRefreshToken, now, nil
}

// appendAuditBestEffort mirrors usage-service's "the write that already
// committed doesn't fail because of a best-effort side effect" pattern —
// see that service's RecordUsageSession doc comment for the same rationale
// applied to event publishing.
func (uc *Login) appendAuditBestEffort(ctx context.Context, user domain.User, now time.Time) {
	entry, err := domain.NewAuditEntry(uuid.NewString(), user.TenantID, user.ID, "user.login", user.ID, domain.OutcomeAllowed, "", now)
	if err != nil {
		return
	}
	_ = uc.audit.Append(ctx, entry)
}
