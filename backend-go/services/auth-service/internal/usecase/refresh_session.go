package usecase

import (
	"context"
	"errors"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// DefaultRefreshTokenTTL is used when no explicit refresh-token TTL is
// configured — typically longer-lived than DefaultSessionTTL (30d vs 24h),
// per domain.Session.RefreshExpiresAt's doc comment.
const DefaultRefreshTokenTTL = 30 * 24 * time.Hour

// RefreshSessionInput mirrors the gRPC RefreshSessionRequest 1:1.
type RefreshSessionInput struct {
	RefreshToken string
}

// RefreshSessionOutput mirrors RefreshSessionResponse. TASK-BE-011 originally
// shipped this without a refresh token, which made a second refresh
// impossible (nothing to rotate to next time) — TASK-BE-012 added
// RefreshToken here and to the proto to close that gap; see this package's
// refresh_session.go doc comment on RefreshSession.Execute for detail.
type RefreshSessionOutput struct {
	SessionToken string
	ExpiresAt    time.Time
	RefreshToken string
}

// RefreshSession rotates Orca's own opaque browser-session token — never
// the upstream IdP's OAuth refresh_token (explicitly out of scope, see
// auth.proto's doc comment on the RPC). Unauthenticated by necessity, like
// Login: the caller has no valid session token to prove identity with yet,
// only a refresh token.
type RefreshSession struct {
	sessions   SessionRepository
	clock      Clock
	sessionTTL time.Duration
	refreshTTL time.Duration
}

func NewRefreshSession(sessions SessionRepository, clock Clock, sessionTTL, refreshTTL time.Duration) *RefreshSession {
	if sessionTTL <= 0 {
		sessionTTL = DefaultSessionTTL
	}
	if refreshTTL <= 0 {
		refreshTTL = DefaultRefreshTokenTTL
	}
	return &RefreshSession{sessions: sessions, clock: clock, sessionTTL: sessionTTL, refreshTTL: refreshTTL}
}

func (uc *RefreshSession) Execute(ctx context.Context, in RefreshSessionInput) (RefreshSessionOutput, error) {
	if in.RefreshToken == "" {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_REFRESH_TOKEN", "refresh_token is required", nil)
	}

	refreshHash := domain.HashSessionToken(in.RefreshToken)
	session, err := uc.sessions.GetSessionByRefreshTokenHash(ctx, refreshHash)
	if errors.Is(err, ErrSessionNotFound) {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_REFRESH_TOKEN_INVALID", "refresh token is invalid", nil)
	}
	if err != nil {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_REFRESH_SESSION_LOOKUP_FAILED", "failed to look up refresh token", err)
	}

	now := uc.clock.Now()

	// Reuse detection: this refresh token was already rotated away by a
	// prior RefreshSession call — its session row is revoked but kept
	// around (not deleted), exactly so a second presentation of the same
	// refresh token can be recognized here. Per auth-service.md §9's
	// reuse-detection principle (documented there for the not-yet-built
	// mobile/CLI refresh-token family, applied here for browser-session
	// refresh too), this is treated as a signal the token was stolen:
	// revoke every session for this user, not just deny this one request.
	if session.RevokedAt != nil {
		_, _ = uc.sessions.RevokeAllForUser(ctx, session.UserID, now)
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_REFRESH_TOKEN_REUSED", "refresh token reuse detected; all sessions for this user have been revoked", nil)
	}

	if !session.RefreshExpiresAt.After(now) {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindPermissionDenied, "AUTH_REFRESH_TOKEN_EXPIRED", "refresh token has expired", nil)
	}

	// Rotate: revoke the old session row (kept, not deleted — see the
	// reuse-detection comment above), then mint a brand-new session with
	// its own TokenHash + RefreshTokenHash.
	if err := uc.sessions.RevokeSession(ctx, session.TokenHash, now); err != nil {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_REFRESH_SESSION_REVOKE_FAILED", "failed to revoke prior session", err)
	}

	rawToken, err := generateRandomToken(32)
	if err != nil {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_TOKEN_GEN_FAILED", "failed to generate session token", err)
	}
	rawRefreshToken, err := generateRandomToken(32)
	if err != nil {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_TOKEN_GEN_FAILED", "failed to generate refresh token", err)
	}

	newSession, err := domain.NewSession(domain.HashSessionToken(rawToken), session.UserID, session.TenantID, now, now.Add(uc.sessionTTL))
	if err != nil {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_INVALID_SESSION", err.Error(), err)
	}
	newSession.RefreshTokenHash = domain.HashSessionToken(rawRefreshToken)
	newSession.RefreshExpiresAt = now.Add(uc.refreshTTL)

	if err := uc.sessions.CreateSession(ctx, newSession); err != nil {
		return RefreshSessionOutput{}, apperrors.New(apperrors.KindInternal, "AUTH_SESSION_CREATE_FAILED", "failed to create refreshed session", err)
	}

	return RefreshSessionOutput{SessionToken: rawToken, ExpiresAt: newSession.ExpiresAt, RefreshToken: rawRefreshToken}, nil
}
