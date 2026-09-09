package usecase

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// DeactivateUser is an admin-console operation — flips a user's is_active
// flag to false. Distinct from delete: the user row and its history (audit
// entries, past sessions) are kept, only new logins are blocked (see
// Login's is_active check).
type DeactivateUser struct {
	users UserRepository
	audit AuditRepository
	clock Clock
	opa   OPAClient
}

func NewDeactivateUser(users UserRepository, audit AuditRepository, clock Clock, opa OPAClient) *DeactivateUser {
	return &DeactivateUser{users: users, audit: audit, clock: clock, opa: opa}
}

func (uc *DeactivateUser) Execute(ctx context.Context, userID string) (domain.User, error) {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return domain.User{}, err
	}
	if userID == "" {
		return domain.User{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_USER_ID", "user_id is required", nil)
	}

	if err := uc.users.SetActive(ctx, userID, false); err != nil {
		return domain.User{}, apperrors.New(apperrors.KindInternal, "AUTH_DEACTIVATE_USER_FAILED", "failed to deactivate user", err)
	}
	updated, err := uc.users.GetUserByID(ctx, userID)
	if errors.Is(err, ErrUserNotFound) {
		return domain.User{}, apperrors.New(apperrors.KindNotFound, "AUTH_USER_NOT_FOUND", "user not found", err)
	}
	if err != nil {
		return domain.User{}, apperrors.New(apperrors.KindInternal, "AUTH_USER_LOOKUP_FAILED", "failed to look up user", err)
	}

	now := uc.clock.Now()
	if entry, err := domain.NewAuditEntry(uuid.NewString(), updated.TenantID, actor.ID, "user.deactivated", updated.ID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}
	return updated, nil
}
