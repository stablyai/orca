package usecase

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// ForceRevokeSession is the admin-console single-session kill action for
// the Sessions tab's per-row "kill" button — distinct from RevokeSession
// (which expects the session's RAW, unhashed token, never seen by an admin
// looking at someone else's session) and ForceRevokeAllSessionsForUser
// (kills every session for a user).
//
// Added for CR-RBAC-001/TASK-BE-030 after discovering that wiring
// RevokeSession directly to the Sessions tab would never work:
// ListSessionsForUser's Session.Id is already the token HASH (per its own
// proto doc comment, "opaque token hash, never the raw token"), but
// RevokeSession's usecase re-hashes whatever string it's given
// (domain.HashSessionToken(sessionToken)) — feeding it an already-hashed
// value hashes it a second time and can never match the stored row, so the
// RPC would always return AUTH_SESSION_NOT_FOUND. This usecase instead
// calls SessionRepository.RevokeSession(ctx, tokenHash, ...) directly with
// the hash the admin console actually has, skipping the re-hash step.
type ForceRevokeSession struct {
	users    UserRepository
	sessions SessionRepository
	audit    AuditRepository
	clock    Clock
	opa      OPAClient
}

func NewForceRevokeSession(users UserRepository, sessions SessionRepository, audit AuditRepository, clock Clock, opa OPAClient) *ForceRevokeSession {
	return &ForceRevokeSession{users: users, sessions: sessions, audit: audit, clock: clock, opa: opa}
}

// Execute revokes the session identified by sessionID (the token hash, as
// returned by ListSessionsForUser). Looking the session up first (rather
// than blindly revoking) lets the audit entry record which user's session
// was killed, and turns "no such session" into a proper 404 instead of a
// silent no-op.
func (uc *ForceRevokeSession) Execute(ctx context.Context, sessionID string) error {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return err
	}
	if sessionID == "" {
		return apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_SESSION_ID", "session_id is required", nil)
	}

	session, err := uc.sessions.GetSessionByTokenHash(ctx, sessionID)
	if errors.Is(err, ErrSessionNotFound) {
		return apperrors.New(apperrors.KindNotFound, "AUTH_SESSION_NOT_FOUND", "session not found", err)
	}
	if err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_SESSION_LOOKUP_FAILED", "failed to look up session", err)
	}

	now := uc.clock.Now()
	if err := uc.sessions.RevokeSession(ctx, sessionID, now); err != nil {
		return apperrors.New(apperrors.KindInternal, "AUTH_SESSION_REVOKE_FAILED", "failed to revoke session", err)
	}

	if entry, err := domain.NewAuditEntry(uuid.NewString(), actor.TenantID, actor.ID, "session.force_revoke", session.UserID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}
	return nil
}
