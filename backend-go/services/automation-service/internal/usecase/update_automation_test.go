package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

func TestUpdateAutomation_OnlyChangesProvidedFields(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedAutomation(t, repo, "tenant-1", "auto-1", `{"step_type":"agent"}`)
	original := repo.byID["auto-1"]

	uc := NewUpdateAutomation(repo)
	newName := "renamed"
	updated, err := uc.Execute(context.Background(), UpdateAutomationInput{TenantID: "tenant-1", ID: "auto-1", Name: &newName})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Name != "renamed" {
		t.Errorf("expected name updated, got %q", updated.Name)
	}
	if updated.RRule != original.RRule {
		t.Errorf("expected rrule to remain unchanged, got %q want %q", updated.RRule, original.RRule)
	}
	if updated.StepConfigJSON != original.StepConfigJSON {
		t.Errorf("expected step_config_json to remain unchanged, got %q", updated.StepConfigJSON)
	}
	if updated.Enabled != original.Enabled {
		t.Errorf("expected enabled to remain unchanged, got %v", updated.Enabled)
	}

	persisted := repo.byID["auto-1"]
	if persisted.Name != "renamed" {
		t.Errorf("expected the repository to receive the merged automation, got name=%q", persisted.Name)
	}
}

func TestUpdateAutomation_TogglesEnabledOnly(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedAutomation(t, repo, "tenant-1", "auto-1", `{"step_type":"agent"}`)

	uc := NewUpdateAutomation(repo)
	enabled := false
	updated, err := uc.Execute(context.Background(), UpdateAutomationInput{TenantID: "tenant-1", ID: "auto-1", Enabled: &enabled})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.Enabled {
		t.Error("expected enabled=false after toggling")
	}
	if updated.Name != "nightly-report" {
		t.Errorf("expected name to remain unchanged, got %q", updated.Name)
	}
}

func TestUpdateAutomation_NotFound_ReturnsError(t *testing.T) {
	repo := newFakeAutomationRepository()
	uc := NewUpdateAutomation(repo)

	_, err := uc.Execute(context.Background(), UpdateAutomationInput{TenantID: "tenant-1", ID: "missing"})
	if err == nil {
		t.Fatal("expected error for missing automation")
	}
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %T", err)
	}
	if appErr.Kind != apperrors.KindNotFound {
		t.Errorf("expected KindNotFound, got %v", appErr.Kind)
	}
}

func TestUpdateAutomation_InvalidRRuleRejected(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedAutomation(t, repo, "tenant-1", "auto-1", `{"step_type":"agent"}`)

	uc := NewUpdateAutomation(repo)
	badRule := "NOT-A-VALID-RRULE"
	_, err := uc.Execute(context.Background(), UpdateAutomationInput{TenantID: "tenant-1", ID: "auto-1", RRule: &badRule})
	if err == nil {
		t.Fatal("expected an error for a malformed rrule")
	}
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %T", err)
	}
	if appErr.Kind != apperrors.KindInvalidArgument {
		t.Errorf("expected KindInvalidArgument, got %v", appErr.Kind)
	}

	// The rejected edit must not be persisted.
	if repo.byID["auto-1"].RRule == badRule {
		t.Error("expected the invalid rrule to not be persisted")
	}
}

func TestUpdateAutomation_EmptyNameRejected(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedAutomation(t, repo, "tenant-1", "auto-1", `{"step_type":"agent"}`)

	uc := NewUpdateAutomation(repo)
	empty := ""
	_, err := uc.Execute(context.Background(), UpdateAutomationInput{TenantID: "tenant-1", ID: "auto-1", Name: &empty})
	if err == nil {
		t.Fatal("expected an error for an empty name")
	}
}

func TestUpdateAutomation_UpdatesStepTypeAndDtstart(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedAutomation(t, repo, "tenant-1", "auto-1", `{"command":"echo hi"}`)

	uc := NewUpdateAutomation(repo)
	stepType := domain.StepTypeShell
	dtstart := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	updated, err := uc.Execute(context.Background(), UpdateAutomationInput{
		TenantID: "tenant-1", ID: "auto-1", StepType: &stepType, Dtstart: &dtstart,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.StepType != domain.StepTypeShell {
		t.Errorf("expected step_type=shell, got %v", updated.StepType)
	}
	if !updated.DTStart.Equal(dtstart) {
		t.Errorf("expected dtstart=%v, got %v", dtstart, updated.DTStart)
	}
}

// CR-AUTO-002/TASK-BE-AUTO-005

func TestUpdateAutomation_NilActions_LeavesExistingChainUnchanged(t *testing.T) {
	repo := newFakeAutomationRepository()
	automation := seedAutomation(t, repo, "tenant-1", "auto-1", `{}`)
	automation.Actions = []domain.AutomationAction{{ID: "a1", Type: domain.AutomationActionTypeRunAgent, ConfigJSON: `{}`}}
	_ = repo.Update(context.Background(), "tenant-1", automation)

	uc := NewUpdateAutomation(repo)
	enabled := false
	updated, err := uc.Execute(context.Background(), UpdateAutomationInput{
		TenantID: "tenant-1", ID: "auto-1", Enabled: &enabled, // Actions field left nil
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(updated.Actions) != 1 || updated.Actions[0].ID != "a1" {
		t.Fatalf("expected the existing action chain to survive an update that doesn't mention Actions, got %+v", updated.Actions)
	}
}

func TestUpdateAutomation_NonNilEmptyActions_ClearsTheChain(t *testing.T) {
	repo := newFakeAutomationRepository()
	automation := seedAutomation(t, repo, "tenant-1", "auto-1", `{}`)
	automation.Actions = []domain.AutomationAction{{ID: "a1", Type: domain.AutomationActionTypeRunAgent, ConfigJSON: `{}`}}
	_ = repo.Update(context.Background(), "tenant-1", automation)

	uc := NewUpdateAutomation(repo)
	empty := []domain.AutomationAction{}
	updated, err := uc.Execute(context.Background(), UpdateAutomationInput{
		TenantID: "tenant-1", ID: "auto-1", Actions: &empty,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(updated.Actions) != 0 {
		t.Fatalf("expected an explicit empty Actions slice to clear the chain, got %+v", updated.Actions)
	}
}

func TestUpdateAutomation_ReplacesActionsWhenProvided(t *testing.T) {
	repo := newFakeAutomationRepository()
	seedAutomation(t, repo, "tenant-1", "auto-1", `{}`)

	uc := NewUpdateAutomation(repo)
	newActions := []domain.AutomationAction{
		{ID: "b1", Type: domain.AutomationActionTypeRunScript, ConfigJSON: `{"script":"true"}`},
	}
	maxHistory := int32(25)
	updated, err := uc.Execute(context.Background(), UpdateAutomationInput{
		TenantID: "tenant-1", ID: "auto-1", Actions: &newActions, MaxRunHistory: &maxHistory,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(updated.Actions) != 1 || updated.Actions[0].ID != "b1" {
		t.Fatalf("expected the new action chain to replace the old one, got %+v", updated.Actions)
	}
	if updated.MaxRunHistory != 25 {
		t.Errorf("MaxRunHistory = %d, want 25", updated.MaxRunHistory)
	}
}
