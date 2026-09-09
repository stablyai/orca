package domain

import (
	"errors"
	"time"
)

// RunStatus is an AutomationRun's lifecycle state. Deliberately a small,
// closed set (unlike TS's `skipped_unavailable`, which existed only because
// TS had no working execution path — see
// specs/backend-go/services/automation-service.md §2/§10): after this
// redesign, RunNow always reaches Succeeded or Failed, never a silent skip.
type RunStatus string

const (
	RunStatusPending   RunStatus = "pending"
	RunStatusRunning   RunStatus = "running"
	RunStatusSucceeded RunStatus = "succeeded"
	RunStatusFailed    RunStatus = "failed"
)

func (s RunStatus) Valid() bool {
	switch s {
	case RunStatusPending, RunStatusRunning, RunStatusSucceeded, RunStatusFailed:
		return true
	default:
		return false
	}
}

func (s RunStatus) Terminal() bool {
	return s == RunStatusSucceeded || s == RunStatusFailed
}

// RunTrigger records what caused a run to be dispatched — the same RunNow
// interactor is reached from a direct gRPC call (manual), the scheduler
// ticker (scheduled), and HandleExternalTrigger (external); see
// specs/backend-go/services/automation-service.md §3/§7.
type RunTrigger string

const (
	RunTriggerManual    RunTrigger = "manual"
	RunTriggerScheduled RunTrigger = "scheduled"
	RunTriggerExternal  RunTrigger = "external"
)

func (t RunTrigger) Valid() bool {
	switch t {
	case RunTriggerManual, RunTriggerScheduled, RunTriggerExternal:
		return true
	default:
		return false
	}
}

var (
	// ErrEmptyAutomationID guards against an orphaned run with no owning
	// automation.
	ErrEmptyAutomationID = errors.New("domain: automation_id is required")
	// ErrEmptyRequestID guards against a run with no idempotency key — see
	// automation-service.md §8: every dispatch must carry a request_id.
	ErrEmptyRequestID = errors.New("domain: request_id is required")
	// ErrInvalidTransition is returned by the Mark* methods when called on a
	// run that isn't in the expected prior state — a run's status machine is
	// linear (pending -> running -> succeeded|failed), never revisited.
	ErrInvalidTransition = errors.New("domain: invalid automation run status transition")
)

// AutomationRun is one dispatch of an Automation — bookkeeping only. The
// actual step execution happens on workflow-service's side; this record
// tracks the outcome workflow-service reported back synchronously.
type AutomationRun struct {
	ID             string
	AutomationID   string
	TenantID       string
	RequestID      string // idempotency key, see automation-service.md §8
	Status         RunStatus
	StepType       StepType
	Trigger        RunTrigger
	StepConfigJSON string
	OutputJSON     string
	ErrorMessage   string
	CreatedAt      time.Time
	StartedAt      time.Time
	CompletedAt    time.Time
	// ActionResults — CR-AUTO-002/TASK-BE-AUTO-003. Per-action outcome, set
	// directly by the usecase layer as ExecuteAutomationChain dispatches
	// each action (TASK-BE-AUTO-004) — mirrors Automation.Actions'
	// post-construction-assignment convention.
	ActionResults []ActionResult
}

// NewPendingRun constructs a freshly-created AutomationRun in the Pending
// state, before workflow-service has been called. trigger defaults to
// RunTriggerManual when invalid/unset, mirroring NewAutomation's
// self-defaulting StepType so every AutomationRun is structurally valid.
func NewPendingRun(id, automationID, tenantID, requestID string, stepType StepType, trigger RunTrigger, stepConfigJSON string, createdAt time.Time) (AutomationRun, error) {
	if automationID == "" {
		return AutomationRun{}, ErrEmptyAutomationID
	}
	if tenantID == "" {
		return AutomationRun{}, ErrEmptyTenant
	}
	if requestID == "" {
		return AutomationRun{}, ErrEmptyRequestID
	}
	if stepConfigJSON == "" {
		return AutomationRun{}, ErrEmptyStepConfig
	}
	if !trigger.Valid() {
		trigger = RunTriggerManual
	}
	return AutomationRun{
		ID:             id,
		AutomationID:   automationID,
		TenantID:       tenantID,
		RequestID:      requestID,
		Status:         RunStatusPending,
		StepType:       stepType,
		Trigger:        trigger,
		StepConfigJSON: stepConfigJSON,
		CreatedAt:      createdAt,
	}, nil
}

// MarkRunning transitions Pending -> Running, recording dispatch time —
// called just before the workflow-service call goes out.
func (r AutomationRun) MarkRunning(startedAt time.Time) (AutomationRun, error) {
	if r.Status != RunStatusPending {
		return r, ErrInvalidTransition
	}
	r.Status = RunStatusRunning
	r.StartedAt = startedAt
	return r, nil
}

// MarkSucceeded transitions Running -> Succeeded with workflow-service's
// reported output.
func (r AutomationRun) MarkSucceeded(completedAt time.Time, outputJSON string) (AutomationRun, error) {
	if r.Status != RunStatusRunning {
		return r, ErrInvalidTransition
	}
	r.Status = RunStatusSucceeded
	r.CompletedAt = completedAt
	r.OutputJSON = outputJSON
	return r, nil
}

// MarkFailed transitions Pending|Running -> Failed. Pending is a valid prior
// state here (unlike MarkSucceeded) because a failure can occur before the
// workflow-service call is even made — e.g. it's unreachable, per
// automation-service.md §8's "fails closed with UNAVAILABLE" requirement.
func (r AutomationRun) MarkFailed(completedAt time.Time, errMsg string) (AutomationRun, error) {
	if r.Status.Terminal() {
		return r, ErrInvalidTransition
	}
	r.Status = RunStatusFailed
	r.CompletedAt = completedAt
	r.ErrorMessage = errMsg
	return r, nil
}
