package usecase

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

func newPendingRunForTest(t *testing.T, automationID string) domain.AutomationRun {
	t.Helper()
	now := time.Now().UTC()
	pending, err := domain.NewPendingRun("run-1", automationID, "tenant-1", "req-1", domain.StepTypeAgent, domain.RunTriggerManual, `{"legacy":true}`, now)
	if err != nil {
		t.Fatalf("NewPendingRun: %v", err)
	}
	running, err := pending.MarkRunning(now)
	if err != nil {
		t.Fatalf("MarkRunning: %v", err)
	}
	return running
}

func TestExecuteAutomationChain_LegacyAutomation_DispatchesSingleActionAndSucceeds(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{"ok":true}`}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if got.Status != domain.RunStatusSucceeded {
		t.Fatalf("Status = %v, want Succeeded", got.Status)
	}
	if len(got.ActionResults) != 1 || got.ActionResults[0].Status != "completed" {
		t.Fatalf("unexpected ActionResults: %+v", got.ActionResults)
	}
	if len(executor.calls) != 1 {
		t.Fatalf("expected exactly 1 ExecuteAdHocStep call, got %d", len(executor.calls))
	}
	if executor.calls[0].StepType != domain.StepTypeAgent || executor.calls[0].StepConfigJSON != `{"prompt":"review"}` {
		t.Errorf("unexpected call: %+v", executor.calls[0])
	}
	if executor.calls[0].RequestID != "run-1:auto-1:legacy" {
		t.Errorf("RequestID = %q, want runID+actionID scoped", executor.calls[0].RequestID)
	}
	if persisted, ok := runs.byID["run-1"]; !ok || persisted.Status != domain.RunStatusSucceeded {
		t.Fatalf("final status not persisted: %+v", persisted)
	}
}

func TestExecuteAutomationChain_MultiActionChain_StopsOnFirstFailureByDefault(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeRunAgent, ConfigJSON: `{"step":1}`},
		{ID: "a2", Type: domain.AutomationActionTypeRunScript, ConfigJSON: `{"step":2}`},
		{ID: "a3", Type: domain.AutomationActionTypeSendNotification, ConfigJSON: `{"step":3}`},
	}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	// a2 fails: fakeWorkflowStepExecutor has no per-call variation, so use a
	// small custom executor that fails on the 2nd call only.
	executor := &sequenceExecutor{
		results: []ExecuteAdHocStepOutput{
			{Status: "completed"},
			{Status: "failed", OutputJSON: "boom"},
			{Status: "completed"},
		},
	}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if got.Status != domain.RunStatusFailed {
		t.Fatalf("Status = %v, want Failed", got.Status)
	}
	if len(got.ActionResults) != 2 {
		t.Fatalf("expected chain to stop after action 2 (2 results), got %d: %+v", len(got.ActionResults), got.ActionResults)
	}
	if executor.callCount != 2 {
		t.Fatalf("expected exactly 2 dispatch calls (chain stopped before a3), got %d", executor.callCount)
	}
}

func TestExecuteAutomationChain_ContinueOnFailure_RunsEveryAction(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeRunAgent, ConfigJSON: `{}`, ContinueOnFailure: true},
		{ID: "a2", Type: domain.AutomationActionTypeSendNotification, ConfigJSON: `{}`, ContinueOnFailure: true},
	}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &sequenceExecutor{results: []ExecuteAdHocStepOutput{
		{Status: "failed"},
		{Status: "completed"},
	}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if executor.callCount != 2 {
		t.Fatalf("expected both actions to run despite a1 failing, got %d calls", executor.callCount)
	}
	if got.Status != domain.RunStatusFailed {
		t.Fatalf("Status = %v, want Failed (a1 still failed, even though the chain continued)", got.Status)
	}
	if len(got.ActionResults) != 2 {
		t.Fatalf("expected 2 action results, got %+v", got.ActionResults)
	}
}

func TestExecuteAutomationChain_UnimplementedActionType_FailsClearlyNotSilently(t *testing.T) {
	// Only CREATE_WORKTREE remains unimplemented as of TASK-BE-AUTO-006 —
	// COMMIT_PUSH (005) and CREATE_PR (006) now have real dispatch paths,
	// see the tests below.
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{{ID: "a1", Type: domain.AutomationActionTypeCreateWorktree, ConfigJSON: `{}`}}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusFailed {
		t.Errorf("Status = %v, want Failed", got.Status)
	}
	if len(got.ActionResults) != 1 || got.ActionResults[0].Error == "" {
		t.Errorf("expected a non-empty error explaining the gap, got %+v", got.ActionResults)
	}
	if len(executor.calls) != 0 {
		t.Error("unimplemented action types must never reach the workflow executor")
	}
}

// CR-AUTO-003/TASK-BE-AUTO-006

func TestExecuteAutomationChain_CommitPush_DispatchesViaWorkflowExecutor(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeCommitPush, ConfigJSON: `{"message":"chore: cleanup"}`},
	}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusSucceeded {
		t.Fatalf("Status = %v, want Succeeded", got.Status)
	}
	if len(executor.calls) != 1 || executor.calls[0].StepType != domain.StepTypeCommitPush {
		t.Fatalf("expected exactly 1 ExecuteAdHocStep call with StepTypeCommitPush, got %+v", executor.calls)
	}
	if executor.calls[0].StepConfigJSON != `{"message":"chore: cleanup"}` {
		t.Errorf("unexpected StepConfigJSON: %q", executor.calls[0].StepConfigJSON)
	}
}

// CR-AUTO-003/TASK-BE-AUTO-007 — explicit StepType assertions (previously
// only exercised indirectly via the multi-action-chain tests above,
// without asserting exactly which StepType each action maps to).

func TestExecuteAutomationChain_RunScript_DispatchesWithStepTypeShell(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeRunScript, ConfigJSON: `{"script":"echo hi"}`},
	}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusSucceeded {
		t.Fatalf("Status = %v, want Succeeded", got.Status)
	}
	if len(executor.calls) != 1 || executor.calls[0].StepType != domain.StepTypeShell {
		t.Fatalf("expected exactly 1 ExecuteAdHocStep call with StepTypeShell, got %+v", executor.calls)
	}
}

func TestExecuteAutomationChain_SendNotification_DispatchesWithStepTypeNotification(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeSendNotification, ConfigJSON: `{"channel":"slack","message":"done"}`},
	}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusSucceeded {
		t.Fatalf("Status = %v, want Succeeded", got.Status)
	}
	if len(executor.calls) != 1 || executor.calls[0].StepType != domain.StepTypeNotification {
		t.Fatalf("expected exactly 1 ExecuteAdHocStep call with StepTypeNotification, got %+v", executor.calls)
	}
}

type fakePullRequestCreator struct {
	calls  []CreatePullRequestInput
	output CreatePullRequestOutput
	err    error
}

func (f *fakePullRequestCreator) CreatePullRequest(ctx context.Context, in CreatePullRequestInput) (CreatePullRequestOutput, error) {
	f.calls = append(f.calls, in)
	if f.err != nil {
		return CreatePullRequestOutput{}, f.err
	}
	return f.output, nil
}

func TestExecuteAutomationChain_CreatePR_DispatchesViaPullRequestCreator(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeCreatePR, ConfigJSON: `{"provider":"github","repo":"acme/widgets","title":"Weekly cleanup","headBranch":"automation/cleanup","baseBranch":"main"}`},
	}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{}
	prs := &fakePullRequestCreator{output: CreatePullRequestOutput{URL: "https://github.com/acme/widgets/pull/42", Number: 42}}
	uc := NewExecuteAutomationChain(automations, runs, executor, prs)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusSucceeded {
		t.Fatalf("Status = %v, want Succeeded (result: %+v)", got.Status, got.ActionResults)
	}
	if len(prs.calls) != 1 {
		t.Fatalf("expected exactly 1 CreatePullRequest call, got %d", len(prs.calls))
	}
	call := prs.calls[0]
	if call.TenantID != "tenant-1" || call.Provider != "github" || call.Repo != "acme/widgets" ||
		call.HeadBranch != "automation/cleanup" || call.BaseBranch != "main" {
		t.Errorf("unexpected CreatePullRequestInput: %+v", call)
	}
	if call.RequestID != "run-1:a1" {
		t.Errorf("RequestID = %q, want runID:actionID scoped", call.RequestID)
	}
	if len(executor.calls) != 0 {
		t.Error("create_pr must never reach the workflow executor — it calls scm-integration-service directly")
	}
	if len(got.ActionResults) != 1 || got.ActionResults[0].OutputJSON == "" {
		t.Fatalf("expected a non-empty OutputJSON, got %+v", got.ActionResults)
	}
}

func TestExecuteAutomationChain_CreatePR_RelayErrorFailsAction(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeCreatePR, ConfigJSON: `{"provider":"github","repo":"acme/widgets","title":"x"}`},
	}
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	prs := &fakePullRequestCreator{err: errCreatePRFailed}
	uc := NewExecuteAutomationChain(automations, runs, &fakeWorkflowStepExecutor{}, prs)

	got, err := uc.Execute(withTenant(context.Background(), "tenant-1"), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusFailed {
		t.Fatalf("Status = %v, want Failed", got.Status)
	}
	if got.ActionResults[0].Error == "" {
		t.Error("expected a non-empty error message")
	}
}

// ── TASK-BE-AUTO-011: running_run_id concurrency guard ──

func TestExecuteAutomationChain_ConcurrentRuns_OnlyOneAcquiresTheLock(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	run1 := newPendingRunForTest(t, automation.ID)
	run1.ID = "run-first"
	run2, err := domain.NewPendingRun("run-second", automation.ID, "tenant-1", "req-2", domain.StepTypeAgent, domain.RunTriggerManual, `{"legacy":true}`, time.Now().UTC())
	if err != nil {
		t.Fatalf("NewPendingRun: %v", err)
	}
	run2, err = run2.MarkRunning(time.Now().UTC())
	if err != nil {
		t.Fatalf("MarkRunning: %v", err)
	}

	// Manually pre-acquire the lock as if run1 is already in flight —
	// simpler and more deterministic than a real goroutine race for
	// asserting "only 1 acquire succeeds."
	acquired, err := automations.AcquireRunLock(context.Background(), "tenant-1", automation.ID, run1.ID, time.Hour)
	if err != nil || !acquired {
		t.Fatalf("pre-acquiring run1's lock: acquired=%v err=%v", acquired, err)
	}

	_, err = uc.Execute(context.Background(), "tenant-1", automation, run2)
	if err == nil {
		t.Fatal("expected run2's Execute to fail while run1 holds the lock")
	}
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) || appErr.Kind != apperrors.KindFailedPrecondition || appErr.Code != "AUTOMATION_ALREADY_RUNNING" {
		t.Fatalf("Execute error = %v, want AppError{Kind: KindFailedPrecondition, Code: AUTOMATION_ALREADY_RUNNING}", err)
	}
	if len(executor.calls) != 0 {
		t.Error("run2 must never dispatch any action while locked out")
	}
}

func TestExecuteAutomationChain_StaleLockPastTTL_SelfHeals(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	automation.RunTimeoutSeconds = 1 // lockTTL = 1s + runLockTTLBuffer(15m) is too long to wait in a unit test — see below
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	run := newPendingRunForTest(t, automation.ID)

	// Simulate a crashed prior run that acquired the lock and never
	// released it, with lockSince backdated past ANY plausible TTL — the
	// fake's AcquireRunLock compares time.Since(lockSince) < ttl, so
	// backdating (rather than waiting out a real TTL) keeps this test fast
	// while still exercising the real self-healing comparison.
	automations.lockRunID[automation.ID] = "crashed-run"
	automations.lockSince[automation.ID] = time.Now().Add(-24 * time.Hour)

	got, err := uc.Execute(context.Background(), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusSucceeded {
		t.Fatalf("Status = %v, want Succeeded (stale lock should self-heal)", got.Status)
	}
}

func TestExecuteAutomationChain_ReleasesLockOnSuccess(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)
	run := newPendingRunForTest(t, automation.ID)

	if _, err := uc.Execute(context.Background(), "tenant-1", automation, run); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if _, held := automations.lockRunID[automation.ID]; held {
		t.Errorf("expected lock to be released after a successful run, still held by %q", automations.lockRunID[automation.ID])
	}
}

func TestExecuteAutomationChain_ReleasesLockOnActionFailure(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{err: fmt.Errorf("boom")}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)
	run := newPendingRunForTest(t, automation.ID)

	got, err := uc.Execute(context.Background(), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusFailed {
		t.Fatalf("Status = %v, want Failed", got.Status)
	}
	if _, held := automations.lockRunID[automation.ID]; held {
		t.Error("expected lock to be released even when the chain ends in Failed")
	}
}

// ── TASK-BE-AUTO-010: max_run_history prune-on-write, run_timeout_seconds ──

func TestExecuteAutomationChain_PrunesRunsAfterSuccess_DefaultMaxRunHistory(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	if _, err := uc.Execute(context.Background(), "tenant-1", automation, run); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if len(runs.prunedCalls) != 1 {
		t.Fatalf("expected exactly 1 PruneRuns call, got %d", len(runs.prunedCalls))
	}
	got := runs.prunedCalls[0]
	if got.TenantID != "tenant-1" || got.AutomationID != automation.ID || got.MaxRuns != defaultMaxRunHistory {
		t.Errorf("PruneRuns called with %+v, want tenant-1/%s/%d", got, automation.ID, defaultMaxRunHistory)
	}
}

func TestExecuteAutomationChain_PrunesRunsAfterSuccess_ConfiguredMaxRunHistory(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	automation.MaxRunHistory = 5
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed"}}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	if _, err := uc.Execute(context.Background(), "tenant-1", automation, run); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if len(runs.prunedCalls) != 1 || runs.prunedCalls[0].MaxRuns != 5 {
		t.Fatalf("expected PruneRuns(maxRuns=5), got %+v", runs.prunedCalls)
	}
}

func TestExecuteAutomationChain_PrunesRunsAfterFailure(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &fakeWorkflowStepExecutor{err: fmt.Errorf("boom")}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	got, err := uc.Execute(context.Background(), "tenant-1", automation, run)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if got.Status != domain.RunStatusFailed {
		t.Fatalf("Status = %v, want Failed", got.Status)
	}
	if len(runs.prunedCalls) != 1 {
		t.Fatalf("expected PruneRuns to run on the failure path too, got %d calls", len(runs.prunedCalls))
	}
}

func TestEffectiveRunTimeout_ZeroFallsBackToDefault(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	if got := effectiveRunTimeout(automation); got != defaultRunTimeout {
		t.Errorf("effectiveRunTimeout(0) = %v, want default %v", got, defaultRunTimeout)
	}
}

func TestEffectiveRunTimeout_UsesConfiguredSeconds(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{}`)
	automation.RunTimeoutSeconds = 30
	if got, want := effectiveRunTimeout(automation), 30*time.Second; got != want {
		t.Errorf("effectiveRunTimeout(30) = %v, want %v", got, want)
	}
}

// deadlineCapturingExecutor records ctx.Deadline() from its first call —
// used to assert Execute derives dispatch's context from
// Automation.RunTimeoutSeconds (TASK-BE-AUTO-010) without needing the test
// to actually wait out a real timeout.
type deadlineCapturingExecutor struct {
	sawDeadline bool
	deadline    time.Time
}

func (f *deadlineCapturingExecutor) ExecuteAdHocStep(ctx context.Context, in ExecuteAdHocStepInput) (ExecuteAdHocStepOutput, error) {
	f.deadline, f.sawDeadline = ctx.Deadline()
	return ExecuteAdHocStepOutput{Status: "completed"}, nil
}

func TestExecuteAutomationChain_DerivesDispatchContextDeadlineFromRunTimeoutSeconds(t *testing.T) {
	automation := mustNewAutomation(t, domain.StepTypeAgent, `{"prompt":"review"}`)
	automation.RunTimeoutSeconds = 60
	run := newPendingRunForTest(t, automation.ID)
	runs := newFakeAutomationRunRepository()
	automations := newFakeAutomationRepository()
	executor := &deadlineCapturingExecutor{}
	uc := NewExecuteAutomationChain(automations, runs, executor, nil)

	start := time.Now()
	if _, err := uc.Execute(context.Background(), "tenant-1", automation, run); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if !executor.sawDeadline {
		t.Fatal("expected dispatch's ctx to carry a deadline derived from RunTimeoutSeconds")
	}
	wantDeadline := start.Add(60 * time.Second)
	if diff := executor.deadline.Sub(wantDeadline); diff < -2*time.Second || diff > 2*time.Second {
		t.Errorf("ctx deadline = %v, want ~%v (diff %v)", executor.deadline, wantDeadline, diff)
	}
}

var errCreatePRFailed = fmt.Errorf("scm-integration-service unreachable")

// sequenceExecutor returns its configured results in call order — used
// where fakeWorkflowStepExecutor's single fixed result/err isn't enough
// (multi-action chains where different actions need different outcomes).
type sequenceExecutor struct {
	results   []ExecuteAdHocStepOutput
	callCount int
}

func (f *sequenceExecutor) ExecuteAdHocStep(ctx context.Context, in ExecuteAdHocStepInput) (ExecuteAdHocStepOutput, error) {
	out := f.results[f.callCount]
	f.callCount++
	return out, nil
}
