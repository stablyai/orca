package usecase

import (
	"context"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func TestGetAdminStats_CountsReflectSeededFixtureData(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)
	seedActiveUser(t, users, fakeHasher{}, "u2", "t1", "u2@example.com", "pw", domain.RoleUser)
	seedActiveUser(t, users, fakeHasher{}, "u3", "t2", "u3@example.com", "pw", domain.RoleUser)

	now := time.Now()
	sessions := newFakeSessionRepository()
	_ = sessions.CreateSession(context.Background(), domain.Session{TokenHash: "active-1", UserID: "u2", TenantID: "t1", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	_ = sessions.CreateSession(context.Background(), domain.Session{TokenHash: "active-2", UserID: "u3", TenantID: "t2", CreatedAt: now, ExpiresAt: now.Add(time.Hour)})
	_ = sessions.CreateSession(context.Background(), domain.Session{TokenHash: "expired-1", UserID: "u2", TenantID: "t1", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour)})
	revokedAt := now
	revoked := domain.Session{TokenHash: "revoked-1", UserID: "u2", TenantID: "t1", CreatedAt: now, ExpiresAt: now.Add(time.Hour), RevokedAt: &revokedAt}
	_ = sessions.CreateSession(context.Background(), revoked)

	policies := newFakeAccessPolicyRepository()
	publisher := &fakePolicyPublisher{}
	clock := &fakeClock{now: now}
	opa := &fakeOPAClient{allow: true}
	ctx := withActor(context.Background(), "t1", "admin1")

	create := NewCreateAccessPolicy(users, policies, publisher, clock, opa)
	if _, err := create.Execute(ctx, CreateAccessPolicyInput{Name: "p1", Kind: "rate-tier", DocumentJSON: `{}`}); err != nil {
		t.Fatalf("seeding policy p1: %v", err)
	}
	if _, err := create.Execute(ctx, CreateAccessPolicyInput{Name: "p2", Kind: "role-definition", DocumentJSON: `{}`}); err != nil {
		t.Fatalf("seeding policy p2: %v", err)
	}
	update := NewUpdateAccessPolicy(users, policies, &fakePolicyPublisher{}, clock, opa)
	// A second version of an existing policy must not inflate the
	// distinct-id count — still 2 policies, now 3 version rows.
	created, err := create.Execute(ctx, CreateAccessPolicyInput{Name: "p3", Kind: "rate-tier", DocumentJSON: `{}`})
	if err != nil {
		t.Fatalf("seeding policy p3: %v", err)
	}
	if _, err := update.Execute(ctx, created.ID, `{"v":2}`, 1); err != nil {
		t.Fatalf("versioning policy p3: %v", err)
	}

	uc := NewGetAdminStats(users, sessions, policies, clock, opa)
	stats, err := uc.Execute(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stats.TotalUsers != 3 {
		t.Errorf("TotalUsers = %d, want 3", stats.TotalUsers)
	}
	if stats.ActiveSessions != 2 {
		t.Errorf("ActiveSessions = %d, want 2 (excluding expired + revoked)", stats.ActiveSessions)
	}
	if stats.TotalPolicies != 3 {
		t.Errorf("TotalPolicies = %d, want 3 distinct ids", stats.TotalPolicies)
	}
}

func TestGetAdminStats_DeniedWhenOPADecisionIsFalse(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "u1", "t1", "member@example.com", "pw", domain.RoleUser)

	uc := NewGetAdminStats(users, newFakeSessionRepository(), newFakeAccessPolicyRepository(), &fakeClock{now: time.Now()}, &fakeOPAClient{allow: false})
	ctx := withActor(context.Background(), "t1", "u1")
	if _, err := uc.Execute(ctx); err == nil {
		t.Fatal("expected an error when OPA denies the actor")
	}
}
