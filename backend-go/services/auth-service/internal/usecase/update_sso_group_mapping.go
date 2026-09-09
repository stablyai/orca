package usecase

import (
	"context"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// UpdateSsoGroupMappingInput mirrors UpdateSsoGroupMappingRequest 1:1.
type UpdateSsoGroupMappingInput struct {
	TenantID  string
	Provider  domain.SsoProvider
	GroupName string
	Role      domain.Role
}

// UpdateSsoGroupMapping is an admin-console operation that upserts one
// (tenant_id, provider, group_name) -> role row — the CR's preferred
// "quản lý qua 1 RPC" DB-backed model (CR-RBAC-003/TASK-BE-009), mirroring
// AccessPolicy's admin-editable posture.
type UpdateSsoGroupMapping struct {
	users    UserRepository
	mappings SsoGroupRoleMappingRepository
	clock    Clock
	opa      OPAClient
}

func NewUpdateSsoGroupMapping(users UserRepository, mappings SsoGroupRoleMappingRepository, clock Clock, opa OPAClient) *UpdateSsoGroupMapping {
	return &UpdateSsoGroupMapping{users: users, mappings: mappings, clock: clock, opa: opa}
}

func (uc *UpdateSsoGroupMapping) Execute(ctx context.Context, in UpdateSsoGroupMappingInput) (domain.SsoGroupRoleMapping, error) {
	if _, err := requireAdminActor(ctx, uc.users, uc.opa); err != nil {
		return domain.SsoGroupRoleMapping{}, err
	}

	now := uc.clock.Now()
	mapping, err := domain.NewSsoGroupRoleMapping(uuid.NewString(), in.TenantID, in.Provider, in.GroupName, in.Role, now)
	if err != nil {
		return domain.SsoGroupRoleMapping{}, apperrors.New(apperrors.KindInvalidArgument, "AUTH_INVALID_SSO_GROUP_MAPPING", err.Error(), err)
	}

	out, err := uc.mappings.Upsert(ctx, mapping)
	if err != nil {
		return domain.SsoGroupRoleMapping{}, apperrors.New(apperrors.KindInternal, "AUTH_UPDATE_SSO_GROUP_MAPPING_FAILED", "failed to update sso group mapping", err)
	}
	return out, nil
}
