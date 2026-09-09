package usecase

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// RevokeSession is the admin-console force-revoke operation — distinct
// from Logout, which only revokes the caller's own session.
type RevokeSession struct {
	users    UserRepository
	sessions SessionRepository
	audit    AuditRepository
	clock    Clock
	opa      OPAClient
}

func NewRevokeSession(users UserRepository, sessions SessionRepository, audit AuditRepository, clock Clock, opa OPAClient) *RevokeSession {
	return &RevokeSession{users: users, sessions: sessions, audit: audit, clock: clock, opa: opa}
}

func (uc *RevokeSession) Execute(ctx context.Context, sessionToken string) error {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return err
	}
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

	if entry, err := domain.NewAuditEntry(uuid.NewString(), session.TenantID, actor.ID, "session.revoked", session.UserID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}
	return nil
}
