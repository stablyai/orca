package usecase

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

// CreateAutomationInput mirrors the gRPC request 1:1 by design — see
// architecture/03's note that usecase granularity mirrors today's RPC
// methods so the TS->Go mapping stays traceable. TenantID is NOT trusted
// from the request body — see Execute below. DTStart/Timezone are the raw
// wire strings (RFC3339 / IANA tz name); empty means "default" — see
// Execute for the resolution rules.
type CreateAutomationInput struct {
	Name           string
	RRule          string
	StepType       domain.StepType
	StepConfigJSON string
	DTStart        string // RFC3339; empty = defaults to now
	Timezone       string // IANA tz name; empty = UTC
	// Actions — CR-AUTO-002/TASK-BE-AUTO-005. Preferred over StepType/
	// StepConfigJSON when non-empty (see resolveActions). A caller MAY
	// populate both (e.g. a legacy StepConfigJSON kept for reference) —
	// Actions always wins at dispatch time.
	Actions           []domain.AutomationAction
	MaxRunHistory     int32 // CR-AUTO-007; 0 = default (100)
	RunTimeoutSeconds int32 // CR-AUTO-007; 0 = default (7200)
}

// CreateAutomation is automation-service's definition-creation path.
type CreateAutomation struct {
	repo AutomationRepository
}

func NewCreateAutomation(repo AutomationRepository) *CreateAutomation {
	return &CreateAutomation{repo: repo}
}

func (uc *CreateAutomation) Execute(ctx context.Context, in CreateAutomationInput) (domain.Automation, error) {
	// TenantID comes from context (populated by the gRPC tenant-extraction
	// interceptor from validated caller metadata), never from the request
	// body, per architecture/05-data-architecture.md's tenant-isolation rule
	// — even though CreateAutomationRequest happens to carry a tenant_id
	// field on the wire (see this service's README "deviations" note).
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.Automation{}, apperrors.New(apperrors.KindUnauthenticated, "AUTOMATION_NO_TENANT", "no tenant in request context", err)
	}

	now := time.Now().UTC()

	dtstart := now
	if in.DTStart != "" {
		parsed, err := time.Parse(time.RFC3339, in.DTStart)
		if err != nil {
			return domain.Automation{}, apperrors.New(apperrors.KindInvalidArgument, "AUTOMATION_INVALID_DTSTART", "dtstart must be RFC3339", err)
		}
		dtstart = parsed
	}

	timezone := in.Timezone
	if timezone != "" {
		loc, err := time.LoadLocation(timezone)
		if err != nil {
			return domain.Automation{}, apperrors.New(apperrors.KindInvalidArgument, "AUTOMATION_INVALID_TIMEZONE", "timezone must be a valid IANA tz name", err)
		}
		dtstart = dtstart.In(loc)
	}

	// New automations default enabled=true — the generated
	// CreateAutomationRequest has no enabled field (Automation does; see
	// automation.proto), so there is nothing on the wire to read here.
	//
	// CR-AUTO-002: NewAutomation's ErrEmptyStepConfig invariant predates
	// Actions — deliberately NOT relaxed (keeps the constructor's existing
	// test coverage and every other call site untouched, per "minimize
	// changes"). An actions-only automation (no legacy step) satisfies the
	// invariant with a harmless "{}" placeholder instead — resolveActions
	// always prefers Actions over StepConfigJSON when Actions is non-empty,
	// so this placeholder is never actually read at dispatch time.
	stepConfigForValidation := in.StepConfigJSON
	if stepConfigForValidation == "" && len(in.Actions) > 0 {
		stepConfigForValidation = "{}"
	}
	automation, err := domain.NewAutomation(uuid.NewString(), tenantID, in.Name, in.RRule, in.StepType, stepConfigForValidation, dtstart, timezone, true, now)
	if err != nil {
		return domain.Automation{}, apperrors.New(apperrors.KindInvalidArgument, "AUTOMATION_INVALID", err.Error(), err)
	}
	automation.Actions = in.Actions
	automation.MaxRunHistory = in.MaxRunHistory
	automation.RunTimeoutSeconds = in.RunTimeoutSeconds

	// Compute the FIRST next_run_at from rrule+dtstart so the scheduler has
	// something to claim without waiting for a first manual RunNow. Anchored
	// at dtstart itself (via a just-before-dtstart probe) rather than "now",
	// so a future dtstart's first occurrence is dtstart, and a past
	// dtstart's first occurrence is the earliest one — catch-up happens
	// naturally the next time the ticker runs, per §8's "a missed tick must
	// not silently drop a run".
	rule, err := automation.RecurrenceRule()
	if err != nil {
		// Unreachable: NewAutomation already validated rrule parses.
		return domain.Automation{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_RRULE_BUILD_FAILED", "failed to build recurrence rule", err)
	}
	if next, ok := rule.NextOccurrenceAfter(dtstart.Add(-time.Second)); ok {
		automation.NextRunAt = next
	}

	if err := uc.repo.Create(ctx, automation); err != nil {
		return domain.Automation{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_CREATE_FAILED", "failed to persist automation", err)
	}
	return automation, nil
}
