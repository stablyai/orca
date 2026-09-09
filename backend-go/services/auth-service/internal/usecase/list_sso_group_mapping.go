package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// ListSsoGroupMappingInput mirrors ListSsoGroupMappingRequest 1:1. Provider
// empty means "every provider" (CR-RBAC-003/TASK-BE-009).
type ListSsoGroupMappingInput struct {
	TenantID string
	Provider domain.SsoProvider
}

// ListSsoGroupMapping is an admin-console operation, mirroring ListUsers'
// shape.
type ListSsoGroupMapping struct {
	users    UserRepository
	mappings SsoGroupRoleMappingRepository
	opa      OPAClient
}

func NewListSsoGroupMapping(users UserRepository, mappings SsoGroupRoleMappingRepository, opa OPAClient) *ListSsoGroupMapping {
	return &ListSsoGroupMapping{users: users, mappings: mappings, opa: opa}
}

func (uc *ListSsoGroupMapping) Execute(ctx context.Context, in ListSsoGroupMappingInput) ([]domain.SsoGroupRoleMapping, error) {
	if _, err := requireAdminActor(ctx, uc.users, uc.opa); err != nil {
		return nil, err
	}

	out, err := uc.mappings.ListForProvider(ctx, in.TenantID, in.Provider)
	if err != nil {
		return nil, apperrors.New(apperrors.KindInternal, "AUTH_LIST_SSO_GROUP_MAPPING_FAILED", "failed to list sso group mappings", err)
	}
	return out, nil
}
