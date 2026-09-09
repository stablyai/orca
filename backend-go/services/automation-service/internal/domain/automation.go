// Package domain holds automation-service's entities and value objects. Per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md, this
// package has zero imports outside stdlib, the RRULE library, and other
// domain/ files — no database, no gRPC, no framework.
package domain

import (
	"errors"
	"time"
)

// StepType mirrors workflow-service's StepType enum (see workflow.proto) —
// duplicated here rather than imported so domain/ stays free of the
// workflowv1 dependency; internal/adapter/grpcclient is the only place that
// translates between the two.
type StepType string

const (
	StepTypeUnspecified  StepType = ""
	StepTypeAgent        StepType = "agent"
	StepTypeShell        StepType = "shell"
	StepTypeNotification StepType = "notification"
	StepTypeWebhook      StepType = "webhook"
	StepTypeCondition    StepType = "condition"
	// StepTypeCommitPush — CR-AUTO-003/TASK-BE-AUTO-005. See
	// workflow-service's domain.StepTypeCommitPush (this const is the same
	// duplication-not-import convention this whole block's doc comment
	// already explains).
	StepTypeCommitPush StepType = "commit_push"
)

func (s StepType) Valid() bool {
	switch s {
	case StepTypeAgent, StepTypeShell, StepTypeNotification, StepTypeWebhook, StepTypeCondition, StepTypeCommitPush:
		return true
	default:
		return false
	}
}

var (
	// ErrEmptyTenant is returned when TenantID is empty — an automation with
	// no owning tenant is never a valid domain state.
	ErrEmptyTenant = errors.New("domain: tenant_id is required")
	// ErrEmptyName guards against a nameless automation, which would be
	// unidentifiable in any list/UI surface.
	ErrEmptyName = errors.New("domain: name is required")
	// ErrEmptyRRule guards against an automation with no recurrence — even a
	// manual-only automation needs a rule per the schema in
	// specs/backend-go/services/automation-service.md §5 (NOT NULL rrule).
	ErrEmptyRRule = errors.New("domain: rrule is required")
	// ErrInvalidRRule is returned when RRule fails to parse as an RFC 5545
	// recurrence string.
	ErrInvalidRRule = errors.New("domain: rrule is not a valid RFC 5545 recurrence rule")
	// ErrEmptyStepConfig guards against an automation with nothing to
	// execute — RunNow would have no step to delegate to workflow-service.
	ErrEmptyStepConfig = errors.New("domain: step_config_json is required")
)

// Automation is a scheduled/triggered automation definition — the system of
// record owned by this service. Execution never happens here; RunNow
// delegates to workflow-service.ExecuteAdHocStep (see
// specs/backend-go/services/automation-service.md §2).
type Automation struct {
	ID       string
	TenantID string
	Name     string
	RRule    string
	// StepType is now a first-class column (migration 0002) rather than a
	// key inside StepConfigJSON — see the former ParseStepType note this
	// replaces. Both internal/adapter/grpcclient (calling workflow-service)
	// and internal/adapter/grpc (translating the wire Automation message,
	// which reuses workflow-service's own StepType enum) map to/from this.
	StepType       StepType
	StepConfigJSON string
	DTStart        time.Time
	// Timezone is the IANA tz name RRULE occurrences are computed in;
	// always resolved to a concrete value ("UTC" if unset) by NewAutomation
	// so every Automation is structurally ready for scheduling.
	Timezone string
	// Enabled gates the scheduler ticker's due-row query
	// (WHERE enabled AND next_run_at <= now()) — a disabled automation is
	// never claimed even if its next_run_at is in the past.
	Enabled bool
	// NextRunAt is the next time the scheduler should dispatch this
	// automation; zero means "no further occurrences" (an exhausted
	// COUNT/UNTIL-bounded rule) or "not yet computed". Advanced by
	// internal/adapter/scheduler after each dispatch.
	NextRunAt time.Time
	CreatedAt time.Time
	UpdatedAt time.Time
	// Actions — CR-AUTO-002/TASK-BE-AUTO-003. Ordered action chain, set
	// directly by the usecase layer after NewAutomation returns (mirrors
	// how internal/adapter/scheduler sets NextRunAt post-construction —
	// same established pattern, not a new one). Empty means "legacy
	// automation, resolve StepType/StepConfigJSON instead" — see
	// usecase.resolveActions (TASK-BE-AUTO-004).
	Actions []AutomationAction
	// MaxRunHistory — CR-AUTO-007/TASK-BE-AUTO-010. 0 = default (100),
	// enforced by the usecase layer, not here.
	MaxRunHistory int32
	// RunTimeoutSeconds — CR-AUTO-007/TASK-BE-AUTO-010. 0 = default (7200).
	RunTimeoutSeconds int32
	// RunningRunID/RunningSince — CR-AUTO-007/TASK-BE-AUTO-011's concurrency
	// guard. Empty/zero means "not currently running". Set/cleared only by
	// the postgres repository's atomic acquire/release (never constructed
	// directly — see AutomationRepository.AcquireRunLock/ReleaseRunLock).
	RunningRunID string
	RunningSince time.Time
}

// AutomationActionType mirrors workflow-service's StepType enum pattern —
// a plain string type, not imported from the generated proto, so domain/
// stays free of the automationv1 dependency (internal/adapter/grpc is the
// only place that translates between the two).
type AutomationActionType string

const (
	AutomationActionTypeUnspecified      AutomationActionType = ""
	AutomationActionTypeCreateWorktree   AutomationActionType = "create_worktree"
	AutomationActionTypeRunAgent         AutomationActionType = "run_agent"
	AutomationActionTypeCommitPush       AutomationActionType = "commit_push"
	AutomationActionTypeCreatePR         AutomationActionType = "create_pr"
	AutomationActionTypeSendNotification AutomationActionType = "send_notification"
	AutomationActionTypeRunScript        AutomationActionType = "run_script"
)

// AutomationAction — CR-AUTO-002. One step in an automation's action chain.
// ConfigJSON is opaque, type-specific — see automation.proto's
// AutomationAction.config_json doc comment; this layer never decodes it
// field-by-field, matching StepConfigJSON's existing convention.
type AutomationAction struct {
	ID                string
	Type              AutomationActionType
	ConfigJSON        string
	ContinueOnFailure bool
}

// ActionResult — CR-AUTO-002. Per-action outcome within one AutomationRun,
// recorded in dispatch order.
type ActionResult struct {
	ActionID   string
	Status     string // running|completed|failed|skipped
	OutputJSON string
	Error      string
}

// NewAutomation constructs an Automation, enforcing the invariants a
// definition must satisfy to be dispatchable — including that RRule parses,
// so a malformed recurrence string is rejected at creation time rather than
// discovered later by the scheduler loop. stepType defaults to
// StepTypeAgent and timezone to "UTC" when unspecified, so every Automation
// this constructor returns is already structurally valid for dispatch —
// callers never need a second defaulting pass. NextRunAt is left zero;
// usecase.CreateAutomation computes it from the resulting RecurrenceRule.
func NewAutomation(id, tenantID, name, rrule string, stepType StepType, stepConfigJSON string, dtstart time.Time, timezone string, enabled bool, createdAt time.Time) (Automation, error) {
	if tenantID == "" {
		return Automation{}, ErrEmptyTenant
	}
	if name == "" {
		return Automation{}, ErrEmptyName
	}
	if rrule == "" {
		return Automation{}, ErrEmptyRRule
	}
	if stepConfigJSON == "" {
		return Automation{}, ErrEmptyStepConfig
	}
	if _, err := NewRecurrenceRule(rrule, dtstart); err != nil {
		return Automation{}, err
	}
	if !stepType.Valid() {
		stepType = StepTypeAgent
	}
	if timezone == "" {
		timezone = "UTC"
	}
	return Automation{
		ID:             id,
		TenantID:       tenantID,
		Name:           name,
		RRule:          rrule,
		StepType:       stepType,
		StepConfigJSON: stepConfigJSON,
		DTStart:        dtstart,
		Timezone:       timezone,
		Enabled:        enabled,
		CreatedAt:      createdAt,
		UpdatedAt:      createdAt,
	}, nil
}

// RecurrenceRule builds this automation's RecurrenceRule value object —
// guaranteed to succeed since NewAutomation already validated RRule parses.
func (a Automation) RecurrenceRule() (RecurrenceRule, error) {
	return NewRecurrenceRule(a.RRule, a.DTStart)
}
