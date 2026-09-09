package usecase

import (
	"time"

	"context"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

// UpdateAutomationInput uses pointer fields: nil = "not being changed"
// (matches the proto's wrapper-typed field-mask shape) — mirrors the
// convention of not conflating "empty string" with "unset."
type UpdateAutomationInput struct {
	TenantID       string
	ID             string
	Name           *string
	RRule          *string
	StepConfigJSON *string
	StepType       *domain.StepType
	Enabled        *bool
	Dtstart        *time.Time
	Timezone       *string
	// Actions — CR-AUTO-002/TASK-BE-AUTO-005. nil = not being changed
	// (same field-mask convention as every other pointer field here); a
	// non-nil, possibly-empty slice DOES replace the chain (an explicit
	// "clear all actions" is a valid edit, distinct from "field not sent"
	// — see automation.proto's AutomationActionList doc comment for why
	// this needed its own wrapper message).
	Actions           *[]domain.AutomationAction
	MaxRunHistory     *int32 // CR-AUTO-007
	RunTimeoutSeconds *int32 // CR-AUTO-007
}

// UpdateAutomation persists a partial edit of an existing Automation.
//
// Concurrency note: the scheduler ticker (adapter/scheduler/) reads
// enabled/next_run_at on its own ~1-minute cadence while this usecase can
// toggle enabled or change rrule concurrently. A read-modify-write Update
// (as implemented) has a narrow race with a concurrent scheduler claim
// (SELECT ... FOR UPDATE SKIP LOCKED) — accepted as "at-least-once, not
// exactly-once, by design" (a stale-enabled window before the next tick
// corrects it). Not solved here.
type UpdateAutomation struct {
	repo AutomationRepository
}

func NewUpdateAutomation(repo AutomationRepository) *UpdateAutomation {
	return &UpdateAutomation{repo: repo}
}

func (uc *UpdateAutomation) Execute(ctx context.Context, in UpdateAutomationInput) (domain.Automation, error) {
	current, err := uc.repo.Get(ctx, in.TenantID, in.ID)
	if err != nil {
		return domain.Automation{}, apperrors.New(apperrors.KindNotFound, "AUTOMATION_NOT_FOUND", "automation not found", err)
	}
	next := current
	if in.Name != nil {
		next.Name = *in.Name
	}
	if in.RRule != nil {
		next.RRule = *in.RRule
	}
	if in.StepConfigJSON != nil {
		next.StepConfigJSON = *in.StepConfigJSON
	}
	if in.StepType != nil {
		next.StepType = *in.StepType
	}
	if in.Enabled != nil {
		next.Enabled = *in.Enabled
	}
	if in.Dtstart != nil {
		next.DTStart = *in.Dtstart
	}
	if in.Timezone != nil {
		next.Timezone = *in.Timezone
	}
	if in.Actions != nil {
		next.Actions = *in.Actions
	}
	if in.MaxRunHistory != nil {
		next.MaxRunHistory = *in.MaxRunHistory
	}
	if in.RunTimeoutSeconds != nil {
		next.RunTimeoutSeconds = *in.RunTimeoutSeconds
	}
	// domain.Automation has no standalone Validate method — reuse
	// NewAutomation's invariant checks (non-empty name/rrule/step config,
	// rrule parses as RFC 5545) by rebuilding from the merged fields. A
	// syntactically valid-at-create rule doesn't stay valid-by-construction
	// after an in-place field edit, so this re-validates on every update.
	// CR-AUTO-002: same "{}" placeholder as CreateAutomation.Execute when
	// Actions covers what StepConfigJSON would otherwise be required for —
	// see that usecase's doc comment for why NewAutomation itself isn't
	// relaxed instead.
	stepConfigForValidation := next.StepConfigJSON
	if stepConfigForValidation == "" && len(next.Actions) > 0 {
		stepConfigForValidation = "{}"
	}
	rebuilt, err := domain.NewAutomation(next.ID, next.TenantID, next.Name, next.RRule, next.StepType, stepConfigForValidation, next.DTStart, next.Timezone, next.Enabled, next.CreatedAt)
	if err != nil {
		return domain.Automation{}, apperrors.New(apperrors.KindInvalidArgument, "AUTOMATION_INVALID", err.Error(), err)
	}
	// NewAutomation defaults an unspecified/invalid StepType and empty
	// Timezone — carry those defaults forward, but keep next's own
	// NextRunAt/UpdatedAt (NewAutomation always returns them zero/reset,
	// and this usecase intentionally leaves scheduling fields untouched).
	next.StepType = rebuilt.StepType
	next.Timezone = rebuilt.Timezone

	if err := uc.repo.Update(ctx, in.TenantID, next); err != nil {
		return domain.Automation{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_UPDATE_FAILED", "failed to persist update", err)
	}
	return next, nil
}
