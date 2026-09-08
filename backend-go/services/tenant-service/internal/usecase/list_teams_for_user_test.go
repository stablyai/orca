package usecase

import (
	"context"
	"testing"

	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

func TestListTeamsForUser_RequiresTenantContext(t *testing.T) {
	uc := NewListTeamsForUser(newFakeTeamRepository())
	if _, err := uc.Execute(context.Background(), ListTeamsForUserInput{UserID: "user-1"}); err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestListTeamsForUser_ReturnsTeamIDs(t *testing.T) {
	teams := newFakeTeamRepository()
	teamA, _ := teams.Create(context.Background(), mustTeam(t, "team-a", "company-1", "Platform", nil))
	teamB, _ := teams.Create(context.Background(), mustTeam(t, "team-b", "company-1", "Growth", nil))
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamA.ID, UserID: "user-1", Priority: 1})
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamB.ID, UserID: "user-1", Priority: 2})

	uc := NewListTeamsForUser(teams)
	ctx := withTenant(context.Background(), "company-1")

	got, err := uc.Execute(ctx, ListTeamsForUserInput{UserID: "user-1"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 team IDs, got %d: %v", len(got), got)
	}
	want := map[string]bool{"team-a": true, "team-b": true}
	for _, id := range got {
		if !want[id] {
			t.Errorf("unexpected team id %q", id)
		}
		delete(want, id)
	}
	if len(want) != 0 {
		t.Errorf("missing expected team ids: %v", want)
	}
}

func TestListTeamsForUser_ScopesByCompany(t *testing.T) {
	teams := newFakeTeamRepository()
	teamA, _ := teams.Create(context.Background(), mustTeam(t, "team-a", "company-a", "Platform", nil))
	teamOther, _ := teams.Create(context.Background(), mustTeam(t, "team-other", "company-b", "Other", nil))
	// Same user_id happens to be a member of teams in two different
	// companies — ListUserTeamLayers' join on tenant.teams.company_id must
	// only surface the caller's own company's membership.
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamA.ID, UserID: "user-1", Priority: 1})
	_ = teams.AddMember(context.Background(), domain.TeamMember{TeamID: teamOther.ID, UserID: "user-1", Priority: 1})

	uc := NewListTeamsForUser(teams)
	ctx := withTenant(context.Background(), "company-a")

	got, err := uc.Execute(ctx, ListTeamsForUserInput{UserID: "user-1"})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(got) != 1 || got[0] != "team-a" {
		t.Fatalf("cross-company leak: expected only [team-a], got %v", got)
	}
}

func TestListTeamsForUser_NoMemberships(t *testing.T) {
	uc := NewListTeamsForUser(newFakeTeamRepository())
	ctx := withTenant(context.Background(), "company-1")

	got, err := uc.Execute(ctx, ListTeamsForUserInput{UserID: "user-with-no-teams"})
	if err != nil {
		t.Fatalf("Execute: %v (expected no error, not-found is not applicable here)", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty slice, got %v", got)
	}
}
