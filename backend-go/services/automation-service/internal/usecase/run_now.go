package usecase

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

// RunNowInput mirrors RunNowRequest (proto/orca/automation/v1/automation.proto),
// plus Trigger — not on the wire message itself, set by each caller: the
// gRPC RunNow handler passes RunTriggerManual, internal/adapter/scheduler
// passes RunTriggerScheduled, HandleExternalTrigger passes
// RunTriggerExternal. Left empty, it defaults to RunTriggerManual (see
// Execute) so existing manual-only callers don't need to change.
type RunNowInput struct {
	AutomationID string
	RequestID    string // idempotency key — see automation-service.md §8
	Trigger      domain.RunTrigger
}

// RunNow is THE core interactor of this service — see
// specs/backend-go/services/automation-service.md §2/§6. It is the only
// code path (scheduler ticks and direct RunNow calls both funnel through
// it) that dispatches a run, and it does so by delegating to
// ExecuteAutomationChain (TASK-BE-AUTO-004's rewire — see that type's own
// doc comment, updated alongside this change), which in turn calls
// workflow-service.ExecuteAdHocStep over real gRPC (WorkflowStepExecutor)
// per action, never executing anything locally. This closes TS Gap 3: TS's
// automation.runNow had no working dispatcher and every triggered run
// resolved skipped_unavailable.
//
// Before this rewire, RunNow.Execute called ExecuteAdHocStep directly and
// returned a Go error whenever that call itself failed (transport-level),
// distinct from a run recorded Failed with no Go error (a business-level
// step failure workflow-service reported cleanly). Delegating to
// ExecuteAutomationChain collapses that distinction: EVERY outcome —
// transport failure, business failure, or success — now resolves to
// (run, nil), with the failure (if any) visible in the run's own
// ActionResults[].Error, never a returned Go error, UNLESS something fails
// before or after dispatch itself (creating the run, or persisting its
// final status). This is a deliberate consequence of adopting the
// multi-action chain model, not an accidental regression: a chain runs N
// actions, and "the whole gRPC call errors" doesn't make sense once one
// failed action among several shouldn't necessarily fail the others (see
// AutomationAction.ContinueOnFailure) — the run's own status/action-results
// carry the failure signal instead, which is still fully visible (never
// "silently swallowed" the way TS's skipped_unavailable was — a Failed run
// with a populated Error field is the opposite of silent). See
// run_now_test.go's TestRunNow_WorkflowServiceFailurePropagatesAndRunRecordedFailed
// for the regression test this rewire updated to match.
type RunNow struct {
	automations AutomationRepository
	runs        AutomationRunRepository
	chain       *ExecuteAutomationChain
}

// RunNowOption configures a RunNow dependency optional at construction —
// today only PullRequestCreator (see WithPullRequestCreator). A variadic
// option, not a positional parameter, so this rewire's required 3 base
// arguments (automations, runs, executor) stay UNCHANGED for every existing
// call site (cmd/server/main.go, every test in this package and the
// scheduler package) — none needed to change to compile.
type RunNowOption func(*runNowOptions)

type runNowOptions struct {
	pullRequests PullRequestCreator
}

// WithPullRequestCreator wires create_pr action dispatch into RunNow's
// internally-built ExecuteAutomationChain. Every existing test call site
// omits this (nil PullRequestCreator — RunNow's own regression tests never
// exercise CREATE_PR; see ExecuteAutomationChain.dispatchCreatePR's own
// nil-check, which fails that one action type clearly rather than
// panicking). cmd/server/main.go passes this for real once
// scm-integration-service is dialed.
func WithPullRequestCreator(pullRequests PullRequestCreator) RunNowOption {
	return func(o *runNowOptions) { o.pullRequests = pullRequests }
}

func NewRunNow(automations AutomationRepository, runs AutomationRunRepository, executor WorkflowStepExecutor, opts ...RunNowOption) *RunNow {
	var o runNowOptions
	for _, opt := range opts {
		opt(&o)
	}
	return &RunNow{
		automations: automations,
		runs:        runs,
		chain:       NewExecuteAutomationChain(automations, runs, executor, o.pullRequests),
	}
}

func (uc *RunNow) Execute(ctx context.Context, in RunNowInput) (domain.AutomationRun, error) {
	tenantID, err := tenant.RequireTenantID(ctx)
	if err != nil {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindUnauthenticated, "AUTOMATION_NO_TENANT", "no tenant in request context", err)
	}
	if in.RequestID == "" {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindInvalidArgument, "AUTOMATION_NO_REQUEST_ID", "request_id is required for idempotent dispatch", nil)
	}

	automation, err := uc.automations.Get(ctx, tenantID, in.AutomationID)
	if err != nil {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindNotFound, "AUTOMATION_NOT_FOUND", "automation not found", err)
	}

	// Idempotency check, per automation-service.md §8: a retried or
	// duplicate-ticked dispatch for the same (automation_id, request_id)
	// returns the existing run instead of calling workflow-service again.
	if existing, found, err := uc.runs.FindByRequestID(ctx, tenantID, automation.ID, in.RequestID); err != nil {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_RUN_LOOKUP_FAILED", "failed to check run idempotency", err)
	} else if found {
		return existing, nil
	}

	// step_type is now a first-class stored column on Automation (migration
	// 0002) rather than a key inside step_config_json — see
	// domain.NewAutomation's doc comment. It's already guaranteed valid
	// (NewAutomation defaults StepTypeUnspecified to StepTypeAgent at
	// creation time), but default again defensively here in case a row
	// predates that migration and still has an empty step_type.
	stepType := automation.StepType
	if !stepType.Valid() {
		stepType = domain.StepTypeAgent
	}

	trigger := in.Trigger
	if !trigger.Valid() {
		trigger = domain.RunTriggerManual
	}

	now := time.Now().UTC()
	pending, err := domain.NewPendingRun(uuid.NewString(), automation.ID, tenantID, in.RequestID, stepType, trigger, automation.StepConfigJSON, now)
	if err != nil {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindInvalidArgument, "AUTOMATION_RUN_INVALID", err.Error(), err)
	}

	if err := uc.runs.Create(ctx, pending); err != nil {
		// A unique-constraint race on (automation_id, request_id) is
		// expected occasionally under at-least-once scheduling (two
		// replicas ticking the same due automation) — re-check once before
		// treating it as a real failure, per §8's "idempotency key makes a
		// duplicate claim harmless" note.
		if existing, found, ferr := uc.runs.FindByRequestID(ctx, tenantID, automation.ID, in.RequestID); ferr == nil && found {
			return existing, nil
		}
		return domain.AutomationRun{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_RUN_CREATE_FAILED", "failed to persist automation run", err)
	}

	running, err := pending.MarkRunning(time.Now().UTC())
	if err != nil {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_RUN_TRANSITION_FAILED", "failed to transition run to running", err)
	}
	if err := uc.runs.UpdateStatus(ctx, running); err != nil {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_RUN_UPDATE_FAILED", "failed to persist run status", err)
	}

	// THE cross-service call this whole service exists for: delegate the
	// run's entire action chain (resolveActions handles the legacy
	// StepType/StepConfigJSON automations transparently — see its own doc
	// comment) to ExecuteAutomationChain, which dispatches each action to
	// workflow-service.ExecuteAdHocStep in turn, persists ActionResults,
	// acquires/releases the concurrency-guard lock, prunes run history, and
	// resolves the run to its terminal Succeeded/Failed status — never
	// executing anything locally itself.
	final, err := uc.chain.Execute(ctx, tenantID, automation, running)
	if err != nil {
		// Execute only returns a Go error for a failure to PERSIST the run's
		// own state transition (see its doc comment) — a dispatched action
		// failing is captured in the run's ActionResults instead, not here.
		return domain.AutomationRun{}, apperrors.New(apperrors.KindInternal, "AUTOMATION_RUN_UPDATE_FAILED", "failed to finalize run status", err)
	}
	return final, nil
}
