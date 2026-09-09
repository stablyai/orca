package usecase

import (
	"context"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func TestUpdateSsoGroupMapping_DeniedWhenOPADecisionIsFalse(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "u1", "t1", "member@example.com", "pw", domain.RoleUser)

	opa := &fakeOPAClient{allow: false}
	uc := NewUpdateSsoGroupMapping(users, newFakeSsoGroupRoleMappingRepository(), &fakeClock{now: time.Now()}, opa)
	ctx := tenant.WithUserID(context.Background(), "u1")
	if _, err := uc.Execute(ctx, UpdateSsoGroupMappingInput{TenantID: "t1", Provider: domain.SsoProviderOIDC, GroupName: "orca-admins", Role: domain.RoleAdmin}); err == nil {
		t.Fatal("expected an error when OPA denies the actor")
	}
}

func TestUpdateSsoGroupMapping_AllowedCreatesMapping(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)

	opa := &fakeOPAClient{allow: true}
	mappings := newFakeSsoGroupRoleMappingRepository()
	uc := NewUpdateSsoGroupMapping(users, mappings, &fakeClock{now: time.Now()}, opa)
	ctx := tenant.WithUserID(context.Background(), "admin1")

	out, err := uc.Execute(ctx, UpdateSsoGroupMappingInput{TenantID: "t1", Provider: domain.SsoProviderOIDC, GroupName: "orca-admins", Role: domain.RoleAdmin})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.ID == "" || out.Role != domain.RoleAdmin || out.GroupName != "orca-admins" {
		t.Errorf("unexpected mapping: %+v", out)
	}

	// Updating the same (tenant, provider, group) again must upsert, not
	// duplicate.
	out2, err := uc.Execute(ctx, UpdateSsoGroupMappingInput{TenantID: "t1", Provider: domain.SsoProviderOIDC, GroupName: "orca-admins", Role: domain.RoleUser})
	if err != nil {
		t.Fatalf("unexpected error on update: %v", err)
	}
	if out2.ID != out.ID {
		t.Errorf("expected the same row id on upsert, got %q vs %q", out2.ID, out.ID)
	}
	if out2.Role != domain.RoleUser {
		t.Errorf("expected role to be updated to user, got %q", out2.Role)
	}

	rows, err := mappings.ListForProvider(ctx, "t1", "")
	if err != nil {
		t.Fatalf("unexpected error listing: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("expected exactly one row after upsert, got %d", len(rows))
	}
}

func TestListSsoGroupMapping_DeniedWhenOPADecisionIsFalse(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "u1", "t1", "member@example.com", "pw", domain.RoleUser)

	opa := &fakeOPAClient{allow: false}
	uc := NewListSsoGroupMapping(users, newFakeSsoGroupRoleMappingRepository(), opa)
	ctx := tenant.WithUserID(context.Background(), "u1")
	if _, err := uc.Execute(ctx, ListSsoGroupMappingInput{TenantID: "t1"}); err == nil {
		t.Fatal("expected an error when OPA denies the actor")
	}
}

func TestListSsoGroupMapping_AllowedFiltersByProvider(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)

	mappings := newFakeSsoGroupRoleMappingRepository()
	mapping1, _ := domain.NewSsoGroupRoleMapping("m1", "t1", domain.SsoProviderOIDC, "orca-admins", domain.RoleAdmin, time.Now())
	mapping2, _ := domain.NewSsoGroupRoleMapping("m2", "t1", domain.SsoProviderGitHub, "org:my-company", domain.RoleUser, time.Now())
	_, _ = mappings.Upsert(context.Background(), mapping1)
	_, _ = mappings.Upsert(context.Background(), mapping2)

	opa := &fakeOPAClient{allow: true}
	uc := NewListSsoGroupMapping(users, mappings, opa)
	ctx := tenant.WithUserID(context.Background(), "admin1")

	all, err := uc.Execute(ctx, ListSsoGroupMappingInput{TenantID: "t1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("expected 2 mappings with no provider filter, got %d", len(all))
	}

	oidcOnly, err := uc.Execute(ctx, ListSsoGroupMappingInput{TenantID: "t1", Provider: domain.SsoProviderOIDC})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(oidcOnly) != 1 || oidcOnly[0].Provider != domain.SsoProviderOIDC {
		t.Errorf("expected 1 oidc mapping, got %+v", oidcOnly)
	}
}
