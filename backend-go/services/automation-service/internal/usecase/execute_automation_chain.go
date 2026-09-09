package usecase

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

// ExecuteAutomationChain — CR-AUTO-002/TASK-BE-AUTO-004. Dispatches
// automation's resolved action chain (resolveActions) in order against an
// already-created, already-Running run, persisting an ActionResult after
// every action, and returns the run in its final terminal state
// (Succeeded/Failed) — same Mark*/UpdateStatus transition discipline
// RunNow.Execute already uses, so a future caller can adopt this without a
// second, divergent status-transition convention.
//
// NOT YET wired as RunNow.Execute's replacement — deliberately. RunNow's
// direct-dispatch path (internal/usecase/run_now.go) is this service's
// core regression guard (closes "TS Gap 3" — see run_now_e2e_test.go).
// As of TASK-BE-AUTO-006, 5 of 6 AutomationActionType values have a real
// executor (RUN_AGENT/RUN_SCRIPT/SEND_NOTIFICATION/COMMIT_PUSH via
// ExecuteAdHocStep — see dispatchViaWorkflow; CREATE_PR via
// PullRequestCreator — see dispatchCreatePR). Only CREATE_WORKTREE remains
// a clear "not yet implemented" ActionResult (see BE-AUTO-SOL-002's own
// open question about backend-go's own worktree-creation path). Rewiring
// RunNow to call this is still a deliberate follow-up, not done here — see
// this task's own doc for the reasoning.
type ExecuteAutomationChain struct {
	automations  AutomationRepository
	runs         AutomationRunRepository
	executor     WorkflowStepExecutor
	pullRequests PullRequestCreator
}

func NewExecuteAutomationChain(automations AutomationRepository, runs AutomationRunRepository, executor WorkflowStepExecutor, pullRequests PullRequestCreator) *ExecuteAutomationChain {
	return &ExecuteAutomationChain{automations: automations, runs: runs, executor: executor, pullRequests: pullRequests}
}

// runLockTTLBuffer is added on top of the chain's own RunTimeoutSeconds to
// size the concurrency-guard lock's TTL (TASK-BE-AUTO-011) — the lock must
// outlive the chain's own timeout (plus the 30s grace this file's final
// status write already uses, see finalCtx below) so a still-legitimately-
// running chain is never preempted by its own lock expiring first.
const runLockTTLBuffer = 15 * time.Minute

// Execute dispatches automation's action chain for run (already created,
// status Running — same precondition RunNow.Execute's caller already
// establishes before calling out to workflow-service). Every action's
// ActionResult is appended and persisted before moving to the next one, so
// a crash mid-chain leaves a partial, inspectable ActionResults list
// instead of losing progress silently. An action with Status "failed" ends
// the chain UNLESS its ContinueOnFailure is true.
func (uc *ExecuteAutomationChain) Execute(ctx context.Context, tenantID string, automation domain.Automation, run domain.AutomationRun) (domain.AutomationRun, error) {
	// Concurrency guard — TASK-BE-AUTO-011. Checked against the ORIGINAL
	// ctx (not yet timeout-wrapped below), before any dispatch work starts.
	// A "busy" outcome (false, nil) is a business-level precondition
	// failure, not an infra error: it returns immediately WITHOUT
	// transitioning run's status — run was already created/marked Running
	// by this method's caller (see doc comment above), and a caller that
	// creates run before confirming the lock is free owns deciding what to
	// do with that now-orphaned row (a future RunNow integration should
	// acquire the lock BEFORE creating the run row, to avoid this case
	// entirely — see this task's own doc for the reasoning).
	lockTTL := effectiveRunTimeout(automation) + runLockTTLBuffer
	acquired, err := uc.automations.AcquireRunLock(ctx, tenantID, automation.ID, run.ID, lockTTL)
	if err != nil {
		return domain.AutomationRun{}, fmt.Errorf("execute_automation_chain: acquiring run lock: %w", err)
	}
	if !acquired {
		return domain.AutomationRun{}, apperrors.New(apperrors.KindFailedPrecondition, "AUTOMATION_ALREADY_RUNNING",
			fmt.Sprintf("automation is already running, run %s in progress", automation.RunningRunID), nil)
	}
	defer func() {
		// Detached from ctx's cancellation/deadline (context.WithoutCancel)
		// for the same reason finalCtx below is — a chain that failed
		// because its own RunTimeoutSeconds elapsed must still be able to
		// release the lock it holds, or every subsequent run of this
		// automation stays blocked until the (much longer) lock TTL itself
		// expires.
		releaseCtx, releaseCancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer releaseCancel()
		_ = uc.automations.ReleaseRunLock(releaseCtx, tenantID, automation.ID, run.ID)
	}()

	// RunTimeoutSeconds bounds the whole chain, not each action — a chain
	// stuck on one slow action (e.g. an agent step that never returns)
	// still needs a hard ceiling so a run can't occupy the automation's
	// RunningRunID slot indefinitely.
	ctx, cancel := context.WithTimeout(ctx, effectiveRunTimeout(automation))
	defer cancel()

	actions := resolveActions(automation)
	hadFailure := false

	for _, action := range actions {
		result := uc.dispatch(ctx, tenantID, run.ID, action)
		run.ActionResults = append(run.ActionResults, result)
		// Best-effort persistence of intermediate progress — a failure to
		// write here must not itself abort the chain (mirrors RunNow's own
		// "best-effort; the transport error below is still returned either
		// way" convention for its failure-path UpdateStatus call).
		_ = uc.runs.UpdateStatus(ctx, run)

		if result.Status == "failed" {
			hadFailure = true
			if !action.ContinueOnFailure {
				break
			}
		}
	}

	// Final status persistence and pruning use a context stripped of the
	// chain's own deadline (context.WithoutCancel): a chain that failed
	// BECAUSE its RunTimeoutSeconds elapsed must still be able to write its
	// terminal "failed" status and release the run-history slot — reusing
	// the expired ctx here would make the timeout path itself fail to
	// persist, leaving the run stuck "running" forever.
	finalCtx, finalCancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer finalCancel()

	now := time.Now().UTC()
	if hadFailure {
		failed, err := run.MarkFailed(now, "one or more actions in the chain failed — see action_results")
		if err != nil {
			return domain.AutomationRun{}, fmt.Errorf("execute_automation_chain: transitioning to failed: %w", err)
		}
		if err := uc.runs.UpdateStatus(finalCtx, failed); err != nil {
			return domain.AutomationRun{}, fmt.Errorf("execute_automation_chain: persisting failed status: %w", err)
		}
		uc.pruneRuns(finalCtx, tenantID, automation)
		return failed, nil
	}

	succeeded, err := run.MarkSucceeded(now, "")
	if err != nil {
		return domain.AutomationRun{}, fmt.Errorf("execute_automation_chain: transitioning to succeeded: %w", err)
	}
	if err := uc.runs.UpdateStatus(finalCtx, succeeded); err != nil {
		return domain.AutomationRun{}, fmt.Errorf("execute_automation_chain: persisting succeeded status: %w", err)
	}
	uc.pruneRuns(finalCtx, tenantID, automation)
	return succeeded, nil
}

// defaultMaxRunHistory/defaultRunTimeout are Automation.MaxRunHistory's and
// Automation.RunTimeoutSeconds's "0 = default" values — see those fields'
// doc comments in domain/automation.go (CR-AUTO-007/TASK-BE-AUTO-010).
const (
	defaultMaxRunHistory = 100
	defaultRunTimeout    = 2 * time.Hour
)

func effectiveRunTimeout(automation domain.Automation) time.Duration {
	if automation.RunTimeoutSeconds <= 0 {
		return defaultRunTimeout
	}
	return time.Duration(automation.RunTimeoutSeconds) * time.Second
}

func effectiveMaxRunHistory(automation domain.Automation) int32 {
	if automation.MaxRunHistory <= 0 {
		return defaultMaxRunHistory
	}
	return automation.MaxRunHistory
}

// pruneRuns is best-effort, mirroring the chain's own intermediate-progress
// UpdateStatus calls above — a prune failure (e.g. a transient DB error)
// must not turn a successfully completed run into an error result; the next
// completed run's prune call will catch up.
func (uc *ExecuteAutomationChain) pruneRuns(ctx context.Context, tenantID string, automation domain.Automation) {
	_ = uc.runs.PruneRuns(ctx, tenantID, automation.ID, effectiveMaxRunHistory(automation))
}

// dispatch routes one action to its executor. Only CREATE_WORKTREE still
// returns a clear "not yet implemented" failure rather than a panic or
// silent no-op (see notImplementedResult) — every other case has a real
// executor as of TASK-BE-AUTO-007 (RUN_SCRIPT/SEND_NOTIFICATION were
// already wired here since TASK-BE-AUTO-004 — both map onto StepType
// values workflow-service already executed for real before this file
// existed; COMMIT_PUSH/CREATE_PR followed in TASK-BE-AUTO-005/006). This
// switch intentionally ships every case pre-declared (TASK-BE-AUTO-004's
// original design) so a reviewer can see at a glance which action types
// still need work.
func (uc *ExecuteAutomationChain) dispatch(ctx context.Context, tenantID, runID string, action domain.AutomationAction) domain.ActionResult {
	switch action.Type {
	case domain.AutomationActionTypeRunAgent:
		return uc.dispatchViaWorkflow(ctx, tenantID, runID, action, domain.StepTypeAgent)
	case domain.AutomationActionTypeRunScript:
		return uc.dispatchViaWorkflow(ctx, tenantID, runID, action, domain.StepTypeShell)
	case domain.AutomationActionTypeSendNotification:
		return uc.dispatchViaWorkflow(ctx, tenantID, runID, action, domain.StepTypeNotification)
	case domain.AutomationActionTypeCommitPush:
		return uc.dispatchViaWorkflow(ctx, tenantID, runID, action, domain.StepTypeCommitPush)
	case domain.AutomationActionTypeCreatePR:
		return uc.dispatchCreatePR(ctx, tenantID, runID, action)
	case domain.AutomationActionTypeCreateWorktree:
		return notImplementedResult(action, "create_worktree")
	default:
		return domain.ActionResult{
			ActionID: action.ID,
			Status:   "failed",
			Error:    fmt.Sprintf("unknown action type %q", action.Type),
		}
	}
}

func notImplementedResult(action domain.AutomationAction, actionType string) domain.ActionResult {
	return domain.ActionResult{
		ActionID: action.ID,
		Status:   "failed",
		Error:    fmt.Sprintf("action type %q: executor not yet implemented", actionType),
	}
}

// dispatchViaWorkflow delegates to workflow-service.ExecuteAdHocStep — the
// SAME call RunNow.Execute already makes for a legacy 1-step automation,
// just parameterized per-action instead of per-automation. requestID is
// runID+action.ID (not automation.ID+action.ID, and not action.ID alone):
// action.ID is stable across every run of the same automation (it's part
// of the automation's definition), so scoping by runID is what makes this
// dispatch's idempotency key unique per attempt, matching RunNow's own
// (automation_id, request_id) uniqueness scoped to one run's RequestID.
func (uc *ExecuteAutomationChain) dispatchViaWorkflow(ctx context.Context, tenantID, runID string, action domain.AutomationAction, stepType domain.StepType) domain.ActionResult {
	out, err := uc.executor.ExecuteAdHocStep(ctx, ExecuteAdHocStepInput{
		TenantID:       tenantID,
		StepType:       stepType,
		StepConfigJSON: action.ConfigJSON,
		RequestID:      runID + ":" + action.ID,
	})
	if err != nil {
		return domain.ActionResult{ActionID: action.ID, Status: "failed", Error: err.Error()}
	}
	return domain.ActionResult{ActionID: action.ID, Status: out.Status, OutputJSON: out.OutputJSON}
}

// createPrActionConfig is CREATE_PR's config_json shape —
// CR-AUTO-003/TASK-BE-AUTO-006. Provider/Repo/HeadBranch/BaseBranch are
// spelled out explicitly here (not inferred from any "automation's bound
// workspace" concept) because automation-service's domain model has none —
// see CreatePullRequestInput's doc comment.
type createPrActionConfig struct {
	Provider   string `json:"provider"`
	Repo       string `json:"repo"`
	Title      string `json:"title"`
	Body       string `json:"body"`
	HeadBranch string `json:"headBranch"`
	BaseBranch string `json:"baseBranch"`
}

// createPrActionOutput is what gets marshaled into a successful CREATE_PR
// ActionResult.OutputJSON.
type createPrActionOutput struct {
	URL    string `json:"url"`
	Number int32  `json:"number"`
}

// dispatchCreatePR — CR-AUTO-003/TASK-BE-AUTO-006. Does NOT go through
// workflow-service/ExecuteAdHocStep (unlike every other action type here) —
// calls scm-integration-service directly via PullRequestCreator, per
// CR-AUTO-003's solution doc: PR creation isn't a "step a Dev Server Agent
// runs," it's a direct API call scm-integration-service already owns.
func (uc *ExecuteAutomationChain) dispatchCreatePR(ctx context.Context, tenantID, runID string, action domain.AutomationAction) domain.ActionResult {
	var cfg createPrActionConfig
	if err := json.Unmarshal([]byte(action.ConfigJSON), &cfg); err != nil {
		return domain.ActionResult{ActionID: action.ID, Status: "failed", Error: fmt.Sprintf("invalid create_pr config: %v", err)}
	}
	if uc.pullRequests == nil {
		return domain.ActionResult{ActionID: action.ID, Status: "failed", Error: "create_pr: no PullRequestCreator configured"}
	}
	out, err := uc.pullRequests.CreatePullRequest(ctx, CreatePullRequestInput{
		TenantID:   tenantID,
		Provider:   cfg.Provider,
		Repo:       cfg.Repo,
		Title:      cfg.Title,
		Body:       cfg.Body,
		HeadBranch: cfg.HeadBranch,
		BaseBranch: cfg.BaseBranch,
		// runID+action.ID: same per-attempt idempotency scoping as
		// dispatchViaWorkflow's RequestID — see that method's doc comment.
		RequestID: runID + ":" + action.ID,
	})
	if err != nil {
		return domain.ActionResult{ActionID: action.ID, Status: "failed", Error: err.Error()}
	}
	outputJSON, err := json.Marshal(createPrActionOutput{URL: out.URL, Number: out.Number})
	if err != nil {
		return domain.ActionResult{ActionID: action.ID, Status: "failed", Error: fmt.Sprintf("marshal output: %v", err)}
	}
	return domain.ActionResult{ActionID: action.ID, Status: "completed", OutputJSON: string(outputJSON)}
}
