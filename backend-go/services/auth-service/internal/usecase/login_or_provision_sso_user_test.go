package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func newLoginOrProvisionSsoUserForTest(users *fakeUserRepository, identities *fakeSsoIdentityRepository, tenants *fakeTenantResolver, now time.Time) *LoginOrProvisionSsoUser {
	return newLoginOrProvisionSsoUserForTestWithMapping(users, identities, tenants, newFakeSsoGroupRoleMappingRepository(), now)
}

func newLoginOrProvisionSsoUserForTestWithMapping(users *fakeUserRepository, identities *fakeSsoIdentityRepository, tenants *fakeTenantResolver, mapping *fakeSsoGroupRoleMappingRepository, now time.Time) *LoginOrProvisionSsoUser {
	return NewLoginOrProvisionSsoUser(users, identities, newFakeSessionRepository(), &fakeAuditRepository{}, fakeHasher{}, tenants, mapping, &fakeClock{now: now}, time.Hour)
}

func TestLoginOrProvisionSsoUser_CreatesNewUser(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	uc := newLoginOrProvisionSsoUserForTest(users, identities, tenants, time.Now())

	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderGitHub, Subject: "12345", Email: "alice@example.com", EmailVerified: true, Name: "Alice",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.SessionToken == "" {
		t.Fatal("expected a non-empty session token")
	}
	if out.User.TenantID != "t1" {
		t.Errorf("tenant_id = %q, want %q", out.User.TenantID, "t1")
	}
	// SSO must never auto-admin.
	if out.User.Role != domain.RoleUser {
		t.Errorf("role = %q, want %q", out.User.Role, domain.RoleUser)
	}
	if identities.linkCalls != 1 {
		t.Errorf("link calls = %d, want 1", identities.linkCalls)
	}
	linked, err := identities.FindByProviderSubject(context.Background(), domain.SsoProviderGitHub, "12345")
	if err != nil || linked.UserID != out.User.ID {
		t.Errorf("expected the new identity to be linked to the created user, got %+v (err=%v)", linked, err)
	}
}

func TestLoginOrProvisionSsoUser_ReturningIdentity_LogsInDirectly(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	now := time.Now()

	existing, err := domain.NewUser("u1", "t1", "bob@example.com", "Bob", domain.RoleUser, true, now)
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	users.seed(existing, "hashed:whatever")
	seeded, err := domain.NewSsoIdentity("id1", "u1", "t1", domain.SsoProviderGoogle, "sub-1", "bob@example.com", now)
	if err != nil {
		t.Fatalf("building identity: %v", err)
	}
	identities.seed(seeded)

	uc := newLoginOrProvisionSsoUserForTest(users, identities, tenants, now)
	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderGoogle, Subject: "sub-1", Email: "bob@example.com", EmailVerified: true, Name: "Bob",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.User.ID != "u1" {
		t.Errorf("user id = %q, want %q", out.User.ID, "u1")
	}
	if identities.linkCalls != 0 {
		t.Errorf("link calls = %d, want 0 — a returning identity must not re-link", identities.linkCalls)
	}
}

func TestLoginOrProvisionSsoUser_LinksVerifiedEmailToExistingLocalAccount(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	now := time.Now()

	existing, err := domain.NewUser("u1", "t1", "carol@example.com", "Carol", domain.RoleUser, true, now)
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	users.seed(existing, "hashed:whatever")

	uc := newLoginOrProvisionSsoUserForTest(users, identities, tenants, now)
	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderOIDC, Subject: "sub-carol", Email: "carol@example.com", EmailVerified: true, Name: "Carol",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.User.ID != "u1" {
		t.Errorf("expected the existing account to be reused, got user id %q", out.User.ID)
	}
	if identities.linkCalls != 1 {
		t.Errorf("link calls = %d, want 1", identities.linkCalls)
	}
	if len(users.byID) != 1 {
		t.Errorf("expected no new user to be created, got %d users", len(users.byID))
	}
}

func TestLoginOrProvisionSsoUser_RejectsUnverifiedEmailCollision(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	now := time.Now()

	existing, err := domain.NewUser("u1", "t1", "dave@example.com", "Dave", domain.RoleUser, true, now)
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	users.seed(existing, "hashed:whatever")

	uc := newLoginOrProvisionSsoUserForTest(users, identities, tenants, now)
	_, err = uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderOIDC, Subject: "sub-dave", Email: "dave@example.com", EmailVerified: false, Name: "Dave",
	})
	if err == nil {
		t.Fatal("expected an error for an unverified-email collision")
	}
	if identities.linkCalls != 0 {
		t.Errorf("link calls = %d, want 0 — an unverified-email collision must never link", identities.linkCalls)
	}
	if len(users.byID) != 1 {
		t.Errorf("expected no new user to be created, got %d users", len(users.byID))
	}
}

func TestLoginOrProvisionSsoUser_RejectsUnverifiedEmailForNewUser(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}

	uc := newLoginOrProvisionSsoUserForTest(users, identities, tenants, time.Now())
	_, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderOIDC, Subject: "sub-mallory", Email: "victim@example.com", EmailVerified: false, Name: "Mallory",
	})
	if err == nil {
		t.Fatal("expected an error when a brand-new signup's email is not verified")
	}
	if len(users.byID) != 0 {
		t.Errorf("expected no user to be created for an unverified email, got %d", len(users.byID))
	}
	if identities.linkCalls != 0 {
		t.Errorf("link calls = %d, want 0", identities.linkCalls)
	}

	// Regression guard for the account-takeover scenario this closes: a
	// later, genuinely verified login for the SAME email must provision a
	// brand-new account of its own — never find and reuse anything the
	// rejected attempt above might have half-created.
	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderGoogle, Subject: "sub-victim-real", Email: "victim@example.com", EmailVerified: true, Name: "Victim",
	})
	if err != nil {
		t.Fatalf("unexpected error on the legitimate, verified signup: %v", err)
	}
	if len(users.byID) != 1 {
		t.Fatalf("expected exactly one user to exist after the verified signup, got %d", len(users.byID))
	}
	linked, err := identities.FindByProviderSubject(context.Background(), domain.SsoProviderGoogle, "sub-victim-real")
	if err != nil || linked.UserID != out.User.ID {
		t.Errorf("expected the verified identity to be linked to the newly (legitimately) created user, got %+v (err=%v)", linked, err)
	}
}

func TestLoginOrProvisionSsoUser_AmbiguousTenant_FailsClosed(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{err: context.DeadlineExceeded}

	uc := newLoginOrProvisionSsoUserForTest(users, identities, tenants, time.Now())
	_, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderGitHub, Subject: "999", Email: "erin@example.com", EmailVerified: true, Name: "Erin",
	})
	if err == nil {
		t.Fatal("expected an error when the tenant can't be resolved")
	}
	if len(users.byID) != 0 {
		t.Errorf("expected no user to be created, got %d", len(users.byID))
	}
	if identities.linkCalls != 0 {
		t.Errorf("link calls = %d, want 0", identities.linkCalls)
	}
}

func TestLoginOrProvisionSsoUser_NewUser_GroupMapsToAdmin_ProvisionedAsAdmin(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	mapping := newFakeSsoGroupRoleMappingRepository()
	now := time.Now()

	m, err := domain.NewSsoGroupRoleMapping("m1", "t1", domain.SsoProviderOIDC, "org:orca-admins", domain.RoleAdmin, now)
	if err != nil {
		t.Fatalf("building mapping: %v", err)
	}
	if _, err := mapping.Upsert(context.Background(), m); err != nil {
		t.Fatalf("seeding mapping: %v", err)
	}

	uc := newLoginOrProvisionSsoUserForTestWithMapping(users, identities, tenants, mapping, now)
	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderOIDC, Subject: "sub-new-admin", Email: "newadmin@example.com", EmailVerified: true, Name: "New Admin",
		Groups: []string{"org:orca-admins"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.User.Role != domain.RoleAdmin {
		t.Errorf("role = %q, want %q", out.User.Role, domain.RoleAdmin)
	}
}

func TestLoginOrProvisionSsoUser_ReturningUserRole_GroupsNowMapToAdmin_Upgraded(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	mapping := newFakeSsoGroupRoleMappingRepository()
	now := time.Now()

	existing, err := domain.NewUser("u1", "t1", "frank@example.com", "Frank", domain.RoleUser, true, now)
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	users.seed(existing, "hashed:whatever")
	seeded, err := domain.NewSsoIdentity("id1", "u1", "t1", domain.SsoProviderOIDC, "sub-frank", "frank@example.com", now)
	if err != nil {
		t.Fatalf("building identity: %v", err)
	}
	identities.seed(seeded)

	m, err := domain.NewSsoGroupRoleMapping("m1", "t1", domain.SsoProviderOIDC, "org:orca-admins", domain.RoleAdmin, now)
	if err != nil {
		t.Fatalf("building mapping: %v", err)
	}
	if _, err := mapping.Upsert(context.Background(), m); err != nil {
		t.Fatalf("seeding mapping: %v", err)
	}

	uc := newLoginOrProvisionSsoUserForTestWithMapping(users, identities, tenants, mapping, now)
	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderOIDC, Subject: "sub-frank", Email: "frank@example.com", EmailVerified: true, Name: "Frank",
		Groups: []string{"org:orca-admins"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.User.Role != domain.RoleAdmin {
		t.Errorf("role = %q, want %q — a returning user whose current groups map to admin must be upgraded", out.User.Role, domain.RoleAdmin)
	}
	stored, err := users.GetUserByID(context.Background(), "u1")
	if err != nil || stored.Role != domain.RoleAdmin {
		t.Errorf("expected the stored user row to be upgraded to admin, got %+v (err=%v)", stored, err)
	}
}

// TestLoginOrProvisionSsoUser_ReturningAdminRole_GroupsNoLongerMapToAdmin_RoleUnchanged
// is the single most important regression guard for CR-RBAC-003's
// anti-lockout decision: a manually-granted admin who is removed from (or
// never was in) an admin-mapped IdP group must NOT be silently downgraded
// on their next login.
func TestLoginOrProvisionSsoUser_ReturningAdminRole_GroupsNoLongerMapToAdmin_RoleUnchanged(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	mapping := newFakeSsoGroupRoleMappingRepository()
	now := time.Now()

	existing, err := domain.NewUser("u1", "t1", "grace@example.com", "Grace", domain.RoleAdmin, true, now)
	if err != nil {
		t.Fatalf("building user: %v", err)
	}
	users.seed(existing, "hashed:whatever")
	seeded, err := domain.NewSsoIdentity("id1", "u1", "t1", domain.SsoProviderOIDC, "sub-grace", "grace@example.com", now)
	if err != nil {
		t.Fatalf("building identity: %v", err)
	}
	identities.seed(seeded)

	// Mapping table maps a DIFFERENT group to admin — grace's current IdP
	// groups (below) don't include it, simulating her having been removed
	// from orca-admins in the IdP.
	m, err := domain.NewSsoGroupRoleMapping("m1", "t1", domain.SsoProviderOIDC, "org:orca-admins", domain.RoleAdmin, now)
	if err != nil {
		t.Fatalf("building mapping: %v", err)
	}
	if _, err := mapping.Upsert(context.Background(), m); err != nil {
		t.Fatalf("seeding mapping: %v", err)
	}

	uc := newLoginOrProvisionSsoUserForTestWithMapping(users, identities, tenants, mapping, now)
	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderOIDC, Subject: "sub-grace", Email: "grace@example.com", EmailVerified: true, Name: "Grace",
		Groups: []string{"org:some-other-team"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.User.Role != domain.RoleAdmin {
		t.Errorf("role = %q, want %q — a manually-granted admin must never be auto-downgraded", out.User.Role, domain.RoleAdmin)
	}
	stored, err := users.GetUserByID(context.Background(), "u1")
	if err != nil || stored.Role != domain.RoleAdmin {
		t.Errorf("expected the stored user row to remain admin, got %+v (err=%v)", stored, err)
	}
}

func TestLoginOrProvisionSsoUser_MappingLookupError_FailsClosedToRoleUser(t *testing.T) {
	users := newFakeUserRepository()
	identities := newFakeSsoIdentityRepository()
	tenants := &fakeTenantResolver{tenantID: "t1"}
	mapping := newFakeSsoGroupRoleMappingRepository()
	mapping.listErr = errors.New("boom: mapping repository unavailable")

	uc := newLoginOrProvisionSsoUserForTestWithMapping(users, identities, tenants, mapping, time.Now())
	out, err := uc.Execute(context.Background(), VerifiedSsoIdentity{
		Provider: domain.SsoProviderOIDC, Subject: "sub-henry", Email: "henry@example.com", EmailVerified: true, Name: "Henry",
		Groups: []string{"org:orca-admins"},
	})
	if err != nil {
		t.Fatalf("a mapping lookup failure must not fail provisioning: %v", err)
	}
	if out.User.Role != domain.RoleUser {
		t.Errorf("role = %q, want %q — a mapping lookup error must fail closed to user, never admin", out.User.Role, domain.RoleUser)
	}
}

func TestLoginOrProvisionSsoUser_RequiresProviderSubjectAndEmail(t *testing.T) {
	uc := newLoginOrProvisionSsoUserForTest(newFakeUserRepository(), newFakeSsoIdentityRepository(), &fakeTenantResolver{tenantID: "t1"}, time.Now())

	if _, err := uc.Execute(context.Background(), VerifiedSsoIdentity{Subject: "1", Email: "a@example.com"}); err == nil {
		t.Error("expected an error for a missing provider")
	}
	if _, err := uc.Execute(context.Background(), VerifiedSsoIdentity{Provider: domain.SsoProviderGitHub, Email: "a@example.com"}); err == nil {
		t.Error("expected an error for a missing subject")
	}
	if _, err := uc.Execute(context.Background(), VerifiedSsoIdentity{Provider: domain.SsoProviderGitHub, Subject: "1"}); err == nil {
		t.Error("expected an error for a missing email")
	}
}
