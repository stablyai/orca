package usecase

import (
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

func mustNewAutomation(t *testing.T, stepType domain.StepType, stepConfigJSON string) domain.Automation {
	t.Helper()
	now := time.Now().UTC()
	a, err := domain.NewAutomation("auto-1", "tenant-1", "n", "FREQ=DAILY", stepType, stepConfigJSON, now, "UTC", true, now)
	if err != nil {
		t.Fatalf("NewAutomation: %v", err)
	}
	return a
}

func TestResolveActions_PrefersActionsWhenPopulated(t *testing.T) {
	a := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"legacy"}`)
	a.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeRunScript, ConfigJSON: `{"script":"true"}`},
	}

	got := resolveActions(a)

	if len(got) != 1 || got[0].ID != "a1" || got[0].Type != domain.AutomationActionTypeRunScript {
		t.Fatalf("unexpected actions: %+v", got)
	}
}

func TestResolveActions_LegacyStepTypeMapping(t *testing.T) {
	cases := []struct {
		stepType domain.StepType
		want     domain.AutomationActionType
	}{
		{domain.StepTypeAgent, domain.AutomationActionTypeRunAgent},
		{domain.StepTypeShell, domain.AutomationActionTypeRunScript},
		{domain.StepTypeNotification, domain.AutomationActionTypeSendNotification},
	}
	for _, c := range cases {
		a := mustNewAutomation(t, c.stepType, `{"k":"v"}`)

		got := resolveActions(a)

		if len(got) != 1 {
			t.Fatalf("stepType=%s: expected exactly 1 resolved action, got %+v", c.stepType, got)
		}
		if got[0].Type != c.want {
			t.Errorf("stepType=%s: action type = %q, want %q", c.stepType, got[0].Type, c.want)
		}
		if got[0].ConfigJSON != `{"k":"v"}` {
			t.Errorf("stepType=%s: ConfigJSON = %q, want the automation's StepConfigJSON verbatim", c.stepType, got[0].ConfigJSON)
		}
		if got[0].ID != "auto-1:legacy" {
			t.Errorf("stepType=%s: action id = %q, want a stable legacy id", c.stepType, got[0].ID)
		}
	}
}

func TestResolveActions_WebhookAndConditionMapToUnspecified(t *testing.T) {
	// No AutomationActionType counterpart exists for these — ExecuteAutomationChain's
	// dispatch must report a clear "unknown action type" failure, not run
	// the wrong action silently.
	for _, st := range []domain.StepType{domain.StepTypeWebhook, domain.StepTypeCondition} {
		a := mustNewAutomation(t, st, `{"k":"v"}`)

		got := resolveActions(a)

		if len(got) != 1 || got[0].Type != domain.AutomationActionTypeUnspecified {
			t.Errorf("stepType=%s: expected AutomationActionTypeUnspecified, got %+v", st, got)
		}
	}
}
