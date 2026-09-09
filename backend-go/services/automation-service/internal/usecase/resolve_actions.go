package usecase

import "github.com/stablyai/orca-go/services/automation-service/internal/domain"

// resolveActions — CR-AUTO-002/TASK-BE-AUTO-004. Returns automation's action
// chain: Actions verbatim if populated, otherwise a single-element chain
// synthesized from the legacy StepType/StepConfigJSON columns — so
// ExecuteAutomationChain never needs to know whether it's looking at a
// pre-CR-AUTO-002 automation or a new one. Returns nil (not an empty slice)
// when there is truly nothing to run (both Actions and StepConfigJSON
// empty) — a domain.NewAutomation-constructed row should never reach that
// state (ErrEmptyStepConfig), but a row that predates that invariant, or a
// future actions-only automation created with a not-yet-updated
// constructor, could.
func resolveActions(a domain.Automation) []domain.AutomationAction {
	if len(a.Actions) > 0 {
		return a.Actions
	}
	if a.StepConfigJSON == "" {
		return nil
	}
	return []domain.AutomationAction{{
		ID:         a.ID + ":legacy",
		Type:       mapFromStepType(a.StepType),
		ConfigJSON: a.StepConfigJSON,
	}}
}

// mapFromStepType mirrors frontend's discussion in CR-AUTO-002 — STEP_TYPE_AGENT
// -> run_agent, STEP_TYPE_SHELL -> run_script, STEP_TYPE_NOTIFICATION ->
// send_notification. STEP_TYPE_WEBHOOK/STEP_TYPE_CONDITION have no
// AutomationActionType counterpart yet (no UI ever created an automation
// with those step types — see CR-AUTO-002's audit) — mapped to
// AutomationActionTypeUnspecified, which ExecuteAutomationChain's dispatch
// reports as a clear "unknown action type" failure rather than silently
// dropping the action.
func mapFromStepType(t domain.StepType) domain.AutomationActionType {
	switch t {
	case domain.StepTypeAgent:
		return domain.AutomationActionTypeRunAgent
	case domain.StepTypeShell:
		return domain.AutomationActionTypeRunScript
	case domain.StepTypeNotification:
		return domain.AutomationActionTypeSendNotification
	default:
		return domain.AutomationActionTypeUnspecified
	}
}
