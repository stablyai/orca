package domain

import (
	"errors"
	"time"
)

var (
	// ErrEmptyGroupName is returned when an SsoGroupRoleMapping is
	// constructed without a group name.
	ErrEmptyGroupName = errors.New("domain: group_name is required")
)

// SsoGroupRoleMapping is one admin-editable (tenant_id, provider,
// group_name) -> role row backing CR-RBAC-003's group->role resolution —
// see auth.sso_group_role_mapping's UNIQUE(tenant_id, provider,
// group_name) constraint, which this type's invariants mirror. Role is
// deliberately restricted to the CR's confirmed 2-tier user/admin model
// (BE-SOL-002), not an open string.
type SsoGroupRoleMapping struct {
	ID        string
	TenantID  string
	Provider  SsoProvider
	GroupName string
	Role      Role
	CreatedAt time.Time
}

// NewSsoGroupRoleMapping constructs an SsoGroupRoleMapping, enforcing a
// valid provider, a non-empty group name, and a valid (user/admin) role.
func NewSsoGroupRoleMapping(id, tenantID string, provider SsoProvider, groupName string, role Role, createdAt time.Time) (SsoGroupRoleMapping, error) {
	if id == "" {
		return SsoGroupRoleMapping{}, ErrEmptyID
	}
	if tenantID == "" {
		return SsoGroupRoleMapping{}, ErrEmptyTenant
	}
	if !provider.Valid() {
		return SsoGroupRoleMapping{}, ErrInvalidProvider
	}
	if groupName == "" {
		return SsoGroupRoleMapping{}, ErrEmptyGroupName
	}
	if !role.Valid() {
		return SsoGroupRoleMapping{}, ErrInvalidRole
	}
	return SsoGroupRoleMapping{
		ID:        id,
		TenantID:  tenantID,
		Provider:  provider,
		GroupName: groupName,
		Role:      role,
		CreatedAt: createdAt,
	}, nil
}
