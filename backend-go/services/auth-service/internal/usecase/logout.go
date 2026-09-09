package usecase

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// Logout revokes the caller's own session — the RPC a client calls with
// its own session token, distinct from the admin-console RevokeSession
// force-revoke (revoke_session.go).
type Logout struct {
	sessions SessionRepository
	audit    AuditRepository
	clock    Clock
}

func NewLogout(sessions SessionRepository, audit AuditRepository, clock Clock) *Logout {
	return &Logout{sessions: sessions, audit: audit, clock: clock}
}

func (uc *Logout) Execute(ctx context.Context, sessionToken string) error {
	if sessionToken == "" {
		return apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_TOKEN", "session_token is required", nil)
	}

	tokenHash := domain.HashSessionToken(sessionToken)
	session, err := uc.sessions.GetSessionByTokenHash(ctx, tokenHash)
	if errors.Is(err, ErrSessionNotFound) {
		return apperrors.New(apperrors.KindNotFound, "AUTH_SESSION_NOT_FOUND", "session not found", err)
	}
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_SESSION_LOOKUP_FAILED", "failed to look up session", err)
	}

	now := uc.clock.Now()
	if err := uc.sessions.RevokeSession(ctx, tokenHash, now); err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_SESSION_REVOKE_FAILED", "failed to revoke session", err)
	}

	if entry, err := domain.NewAuditEntry(uuid.NewString(), session.TenantID, session.UserID, "user.logout", session.UserID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}
	return nil
}
