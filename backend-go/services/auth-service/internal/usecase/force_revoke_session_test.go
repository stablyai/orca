package usecase

import (
	"context"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func TestForceRevokeSession_DeniedWhenOPADecisionIsFalse(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "u1", "t1", "member@example.com", "pw", domain.RoleUser)

	opa := &fakeOPAClient{allow: false}
	uc := NewForceRevokeSession(users, newFakeSessionRepository(), &fakeAuditRepository{}, &fakeClock{now: time.Now()}, opa)
	ctx := withActor(context.Background(), "t1", "u1")
	if err := uc.Execute(ctx, "some-hash"); err == nil {
		t.Fatal("expected an error when OPA denies the actor")
	}
	if !opa.called {
		t.Error("expected OPAClient.Decision to be called")
	}
}

// TestForceRevokeSession_RevokesByHashDirectly is the regression guard for
// this usecase's whole reason for existing: it must accept the session's
// token HASH (as ListSessionsForUser's Session.id already is) and revoke
// that row directly — NOT re-hash the input the way RevokeSession does
// (which would only ever match a RAW token, something an admin viewing
// someone else's session never has).
func TestForceRevokeSession_RevokesByHashDirectly(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)
	sessions := newFakeSessionRepository()
	sessionHash := "already-hashed-session-id"
	if err := sessions.CreateSession(context.Background(), domain.Session{
		TokenHash: sessionHash,
		TenantID:  "t1",
		UserID:    "u2",
		ExpiresAt: time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("seeding session: %v", err)
	}
	audit := &fakeAuditRepository{}

	opa := &fakeOPAClient{allow: true}
	uc := NewForceRevokeSession(users, sessions, audit, &fakeClock{now: time.Now()}, opa)
	ctx := tenant.WithUserID(context.Background(), "admin1")
	if err := uc.Execute(ctx, sessionHash); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	revoked, err := sessions.GetSessionByTokenHash(context.Background(), sessionHash)
	if err != nil {
		t.Fatalf("expected session still findable by hash after revoke: %v", err)
	}
	if revoked.RevokedAt == nil {
		t.Error("expected session to be revoked")
	}
	if len(audit.entries) != 1 || audit.entries[0].Action != "session.force_revoke" || audit.entries[0].Target != "u2" {
		t.Errorf("expected one session.force_revoke audit entry targeting u2, got %+v", audit.entries)
	}
}

func TestForceRevokeSession_UnknownSessionID_ReturnsNotFound(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)

	opa := &fakeOPAClient{allow: true}
	uc := NewForceRevokeSession(users, newFakeSessionRepository(), &fakeAuditRepository{}, &fakeClock{now: time.Now()}, opa)
	ctx := tenant.WithUserID(context.Background(), "admin1")
	if err := uc.Execute(ctx, "no-such-hash"); err == nil {
		t.Fatal("expected AUTH_SESSION_NOT_FOUND for an unknown session id")
	}
}

func TestForceRevokeSession_EmptySessionID_IsInvalidArgument(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)

	opa := &fakeOPAClient{allow: true}
	uc := NewForceRevokeSession(users, newFakeSessionRepository(), &fakeAuditRepository{}, &fakeClock{now: time.Now()}, opa)
	ctx := tenant.WithUserID(context.Background(), "admin1")
	if err := uc.Execute(ctx, ""); err == nil {
		t.Fatal("expected an error for an empty session_id")
	}
}
