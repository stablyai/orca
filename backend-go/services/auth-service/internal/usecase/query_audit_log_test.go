package usecase

import (
	"context"
	"testing"

	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

func TestQueryAuditLog_DeniedWhenOPADecisionIsFalse(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "u1", "t1", "member@example.com", "pw", domain.RoleUser)

	opa := &fakeOPAClient{allow: false}
	uc := NewQueryAuditLog(users, &fakeAuditRepository{}, opa)
	ctx := withActor(context.Background(), "t1", "u1")
	if _, err := uc.Execute(ctx, QueryAuditLogInput{TenantID: "t1"}); err == nil {
		t.Fatal("expected an error when OPA denies the actor")
	}
	if !opa.called {
		t.Error("expected OPAClient.Decision to be called")
	}
}

func TestQueryAuditLog_AllowedWhenOPADecisionIsTrue(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)
	audit := &fakeAuditRepository{entries: []domain.AuditEntry{
		{ID: "e1", TenantID: "t1", ActorID: "admin1", Action: "user.created", Target: "u2"},
	}}

	opa := &fakeOPAClient{allow: true}
	uc := NewQueryAuditLog(users, audit, opa)
	ctx := withActor(context.Background(), "t1", "admin1")
	out, err := uc.Execute(ctx, QueryAuditLogInput{TenantID: "t1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.Entries) != 1 {
		t.Errorf("expected 1 audit entry, got %d", len(out.Entries))
	}
}

func TestQueryAuditLog_FiltersByActorActionOutcome(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)
	audit := &fakeAuditRepository{entries: []domain.AuditEntry{
		{ID: "e1", TenantID: "t1", ActorID: "admin1", Action: "user.created", Target: "u2", Outcome: domain.OutcomeAllowed},
		{ID: "e2", TenantID: "t1", ActorID: "admin2", Action: "user.created", Target: "u3", Outcome: domain.OutcomeAllowed},
		{ID: "e3", TenantID: "t1", ActorID: "admin1", Action: "user.deleted", Target: "u4", Outcome: domain.OutcomeDenied},
	}}
	opa := &fakeOPAClient{allow: true}

	cases := []struct {
		name  string
		input QueryAuditLogInput
		want  []string
	}{
		{"no filters", QueryAuditLogInput{TenantID: "t1"}, []string{"e1", "e2", "e3"}},
		{"actor_id alone", QueryAuditLogInput{TenantID: "t1", ActorID: "admin1"}, []string{"e1", "e3"}},
		{"action alone", QueryAuditLogInput{TenantID: "t1", Action: "user.created"}, []string{"e1", "e2"}},
		{"outcome alone", QueryAuditLogInput{TenantID: "t1", Outcome: domain.OutcomeDenied}, []string{"e3"}},
		{"actor_id + action combined", QueryAuditLogInput{TenantID: "t1", ActorID: "admin1", Action: "user.created"}, []string{"e1"}},
		{"actor_id + outcome combined", QueryAuditLogInput{TenantID: "t1", ActorID: "admin1", Outcome: domain.OutcomeDenied}, []string{"e3"}},
		{"all three combined, no match", QueryAuditLogInput{TenantID: "t1", ActorID: "admin2", Action: "user.created", Outcome: domain.OutcomeDenied}, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			uc := NewQueryAuditLog(users, audit, opa)
			ctx := withActor(context.Background(), "t1", "admin1")
			out, err := uc.Execute(ctx, tc.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			var got []string
			for _, e := range out.Entries {
				got = append(got, e.ID)
			}
			if len(got) != len(tc.want) {
				t.Fatalf("expected entries %v, got %v", tc.want, got)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("expected entries %v, got %v", tc.want, got)
				}
			}
		})
	}
}

func TestQueryAuditLog_FailsClosedOnOPAEvaluationError(t *testing.T) {
	users := newFakeUserRepository()
	seedActiveUser(t, users, fakeHasher{}, "admin1", "t1", "admin@example.com", "pw", domain.RoleAdmin)

	opa := &fakeOPAClient{decisionErr: context.DeadlineExceeded}
	uc := NewQueryAuditLog(users, &fakeAuditRepository{}, opa)
	ctx := withActor(context.Background(), "t1", "admin1")
	if _, err := uc.Execute(ctx, QueryAuditLogInput{TenantID: "t1"}); err == nil {
		t.Fatal("expected an error when OPA evaluation itself fails")
	}
}
