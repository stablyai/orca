package usecase

import (
	"context"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// ForceRevokeAllSessionsForUser is the admin-console "kill all sessions"
// operation — force-revokes every currently-unrevoked session belonging to
// a user, distinct from RevokeSession's single-token force-revoke.
type ForceRevokeAllSessionsForUser struct {
	users    UserRepository
	sessions SessionRepository
	audit    AuditRepository
	clock    Clock
	opa      OPAClient
}

func NewForceRevokeAllSessionsForUser(users UserRepository, sessions SessionRepository, audit AuditRepository, clock Clock, opa OPAClient) *ForceRevokeAllSessionsForUser {
	return &ForceRevokeAllSessionsForUser{users: users, sessions: sessions, audit: audit, clock: clock, opa: opa}
}

func (uc *ForceRevokeAllSessionsForUser) Execute(ctx context.Context, userID string) (int32, error) {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return 0, err
	}
	if userID == "" {
		return 0, apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_USER_ID", "user_id is required", nil)
	}

	now := uc.clock.Now()
	revoked, err := uc.sessions.RevokeAllForUser(ctx, userID, now)
	if err != nil {
		return 0, apperrors.New(apperrors.KindInternal, "AUTH_REVOKE_ALL_SESSIONS_FAILED", "failed to revoke all sessions for user", err)
	}

	// TenantID isn't known here without an extra user lookup this
	// operation otherwise doesn't need — actor.TenantID (the acting
	// admin's own tenant) is the correct audit scope, since cross-tenant
	// admin actions aren't a concept this scaffold supports (see
	// requireAdminActor's doc comment).
	if entry, err := domain.NewAuditEntry(uuid.NewString(), actor.TenantID, actor.ID, "session.force_revoke_all", userID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}
	return revoked, nil
}
