package usecase

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// ReactivateUser is an admin-console operation — flips a user's is_active
// flag back to true, the inverse of DeactivateUser.
type ReactivateUser struct {
	users UserRepository
	audit AuditRepository
	clock Clock
	opa   OPAClient
}

func NewReactivateUser(users UserRepository, audit AuditRepository, clock Clock, opa OPAClient) *ReactivateUser {
	return &ReactivateUser{users: users, audit: audit, clock: clock, opa: opa}
}

func (uc *ReactivateUser) Execute(ctx context.Context, userID string) (domain.User, error) {
	actor, err := requireAdminActor(ctx, uc.users, uc.opa)
	if err != nil {
		return domain.User{}, err
	}
	if userID == "" {
		return domain.User{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_MISSING_USER_ID", "user_id is required", nil)
	}

	if err := uc.users.SetActive(ctx, userID, true); err != nil {
		return domain.User{}, apperrors.New(apperrors.KindInternal, "AUTH_REACTIVATE_USER_FAILED", "failed to reactivate user", err)
	}
	updated, err := uc.users.GetUserByID(ctx, userID)
	if errors.Is(err, ErrUserNotFound) {
		return domain.User{}, apperrors.New(apperrors.KindNotFound, "AUTH_USER_NOT_FOUND", "user not found", err)
	}
	if err != nil {
		return domain.User{}, apperrors.New(apperrors.KindInternal, "AUTH_USER_LOOKUP_FAILED", "failed to look up user", err)
	}

	now := uc.clock.Now()
	if entry, err := domain.NewAuditEntry(uuid.NewString(), updated.TenantID, actor.ID, "user.reactivated", updated.ID, domain.OutcomeAllowed, "", now); err == nil {
		_ = uc.audit.Append(ctx, entry)
	}
	return updated, nil
}
