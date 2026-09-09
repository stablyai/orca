package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

// fakeAutomationRepository is an in-memory AutomationRepository — the "test
// against fakes, not a real database" pattern from
// specs/backend-go/standards/testing-strategy.md's unit-test section.
type fakeAutomationRepository struct {
	byID map[string]domain.Automation
	// lockRunID/lockSince back AcquireRunLock/ReleaseRunLock — kept
	// separate from byID (rather than mutating Automation.RunningRunID
	// in-place) so lock state is exercisable without callers first
	// Create()-ing the automation, matching how execute_automation_chain_test.go
	// builds automations via mustNewAutomation() without registering them.
	lockRunID map[string]string
	lockSince map[string]time.Time
}

func newFakeAutomationRepository() *fakeAutomationRepository {
	return &fakeAutomationRepository{
		byID:      map[string]domain.Automation{},
		lockRunID: map[string]string{},
		lockSince: map[string]time.Time{},
	}
}

// AcquireRunLock mirrors postgres.AutomationRepository.AcquireRunLock's
// semantics: succeeds if unlocked, or if the existing lock is older than
// ttl (self-healing after a simulated crash).
func (f *fakeAutomationRepository) AcquireRunLock(ctx context.Context, tenantID, automationID, runID string, ttl time.Duration) (bool, error) {
	if held, ok := f.lockRunID[automationID]; ok && held != "" {
		if time.Since(f.lockSince[automationID]) < ttl {
			return false, nil
		}
	}
	f.lockRunID[automationID] = runID
	f.lockSince[automationID] = time.Now()
	return true, nil
}

// ReleaseRunLock only clears the lock if runID still holds it — mirrors
// postgres.AutomationRepository.ReleaseRunLock's "don't release someone
// else's lock" guard.
func (f *fakeAutomationRepository) ReleaseRunLock(ctx context.Context, tenantID, automationID, runID string) error {
	if f.lockRunID[automationID] == runID {
		delete(f.lockRunID, automationID)
		delete(f.lockSince, automationID)
	}
	return nil
}

func (f *fakeAutomationRepository) Create(ctx context.Context, a domain.Automation) error {
	f.byID[a.ID] = a
	return nil
}

func (f *fakeAutomationRepository) Get(ctx context.Context, tenantID, id string) (domain.Automation, error) {
	a, ok := f.byID[id]
	if !ok || a.TenantID != tenantID {
		return domain.Automation{}, errors.New("not found")
	}
	return a, nil
}

// List/Update/Delete satisfy usecase.AutomationRepository for tests in this
// package that don't exercise list/update/delete directly (those get their
// own dedicated fakes in list_automations_test.go/update_automation_test.go/
// delete_automation_test.go).
func (f *fakeAutomationRepository) List(ctx context.Context, tenantID, pageToken string, pageSize int32) ([]domain.Automation, string, error) {
	var out []domain.Automation
	for _, a := range f.byID {
		if a.TenantID == tenantID {
			out = append(out, a)
		}
	}
	return out, "", nil
}

func (f *fakeAutomationRepository) Update(ctx context.Context, tenantID string, a domain.Automation) error {
	f.byID[a.ID] = a
	return nil
}

func (f *fakeAutomationRepository) Delete(ctx context.Context, tenantID, id string) error {
	delete(f.byID, id)
	return nil
}

// fakeAutomationRunRepository is an in-memory AutomationRunRepository.
type fakeAutomationRunRepository struct {
	byID        map[string]domain.AutomationRun
	created     int
	prunedCalls []prunedRunsCall
}

// prunedRunsCall records one PruneRuns invocation — asserted by
// TestExecuteAutomationChain_PrunesRunsAfterCompletion.
type prunedRunsCall struct {
	TenantID     string
	AutomationID string
	MaxRuns      int32
}

func newFakeAutomationRunRepository() *fakeAutomationRunRepository {
	return &fakeAutomationRunRepository{byID: map[string]domain.AutomationRun{}}
}

func (f *fakeAutomationRunRepository) Create(ctx context.Context, run domain.AutomationRun) error {
	f.byID[run.ID] = run
	f.created++
	return nil
}

func (f *fakeAutomationRunRepository) FindByRequestID(ctx context.Context, tenantID, automationID, requestID string) (domain.AutomationRun, bool, error) {
	for _, r := range f.byID {
		if r.TenantID == tenantID && r.AutomationID == automationID && r.RequestID == requestID {
			return r, true, nil
		}
	}
	return domain.AutomationRun{}, false, nil
}

func (f *fakeAutomationRunRepository) UpdateStatus(ctx context.Context, run domain.AutomationRun) error {
	f.byID[run.ID] = run
	return nil
}

func (f *fakeAutomationRunRepository) ListByAutomation(ctx context.Context, tenantID, automationID, pageToken string, pageSize int32) ([]domain.AutomationRun, string, error) {
	var out []domain.AutomationRun
	for _, r := range f.byID {
		if r.TenantID == tenantID && r.AutomationID == automationID {
			out = append(out, r)
		}
	}
	return out, "", nil
}

func (f *fakeAutomationRunRepository) PruneRuns(ctx context.Context, tenantID, automationID string, maxRuns int32) error {
	f.prunedCalls = append(f.prunedCalls, prunedRunsCall{TenantID: tenantID, AutomationID: automationID, MaxRuns: maxRuns})
	return nil
}

// fakeWorkflowStepExecutor is a fake WorkflowStepExecutor — RunNow's tests
// verify it's called with the right step_config_json and that idempotent
// retries (same request_id) don't call it a second time.
type fakeWorkflowStepExecutor struct {
	calls  []ExecuteAdHocStepInput
	result ExecuteAdHocStepOutput
	err    error
}

func (f *fakeWorkflowStepExecutor) ExecuteAdHocStep(ctx context.Context, in ExecuteAdHocStepInput) (ExecuteAdHocStepOutput, error) {
	f.calls = append(f.calls, in)
	if f.err != nil {
		return ExecuteAdHocStepOutput{}, f.err
	}
	return f.result, nil
}

func withTenant(ctx context.Context, tenantID string) context.Context {
	return tenant.WithTenantID(ctx, tenantID)
}

func seedAutomation(t *testing.T, repo *fakeAutomationRepository, tenantID, id, stepConfigJSON string) domain.Automation {
	t.Helper()
	return seedAutomationWithStepType(t, repo, tenantID, id, domain.StepTypeAgent, stepConfigJSON)
}

func seedAutomationWithStepType(t *testing.T, repo *fakeAutomationRepository, tenantID, id string, stepType domain.StepType, stepConfigJSON string) domain.Automation {
	t.Helper()
	now := time.Now().UTC()
	a, err := domain.NewAutomation(id, tenantID, "nightly-report", "FREQ=DAILY;INTERVAL=1", stepType, stepConfigJSON, now, "UTC", true, now)
	if err != nil {
		t.Fatalf("building automation: %v", err)
	}
	_ = repo.Create(context.Background(), a)
	return a
}

func TestRunNow_CallsWorkflowStepExecutorWithStepConfig(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{"ok":true}`}}
	uc := NewRunNow(automations, runs, executor)

	stepConfig := `{"step_type":"agent","prompt":"summarize the day"}`
	seedAutomation(t, automations, "tenant-1", "auto-1", stepConfig)

	ctx := withTenant(context.Background(), "tenant-1")
	run, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run.Status != domain.RunStatusSucceeded {
		t.Errorf("expected run to succeed, got status=%v", run.Status)
	}

	if len(executor.calls) != 1 {
		t.Fatalf("expected exactly 1 call to WorkflowStepExecutor, got %d", len(executor.calls))
	}
	call := executor.calls[0]
	if call.StepConfigJSON != stepConfig {
		t.Errorf("expected step_config_json %q to be passed through verbatim, got %q", stepConfig, call.StepConfigJSON)
	}
	if call.StepType != domain.StepTypeAgent {
		t.Errorf("expected step_type=agent parsed from step_config_json, got %v", call.StepType)
	}
	if call.TenantID != "tenant-1" {
		t.Errorf("expected tenant_id=tenant-1, got %v", call.TenantID)
	}
	// Why: TASK-BE-AUTO-004's rewire delegates dispatch to
	// ExecuteAutomationChain, which scopes workflow-service's own
	// idempotency key per (run, action) — run.ID+":"+action.ID, NOT
	// RunNowInput.RequestID verbatim (dispatchViaWorkflow's own doc
	// comment explains why: a multi-action chain needs a distinct key per
	// action, not one key reused for every action in the run). This does
	// NOT weaken RunNow's own idempotency guarantee — a retried call with
	// the same RunNowInput.RequestID still short-circuits via
	// FindByRequestID before ever reaching dispatch (see
	// TestRunNow_IdempotentRetrySameRequestIDDoesNotDuplicateOrRecall).
	wantRequestID := run.ID + ":auto-1:legacy"
	if call.RequestID != wantRequestID {
		t.Errorf("expected request_id=%q (run.ID + legacy action ID), got %v", wantRequestID, call.RequestID)
	}
}

func TestRunNow_DispatchesStructuralStepTypeWithoutTouchingStepConfigJSON(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{}`}}
	uc := NewRunNow(automations, runs, executor)

	// step_config_json deliberately carries no "step_type" key — step_type
	// is now a first-class stored column (migration 0002), not something
	// RunNow parses out of the JSON body.
	stepConfig := `{"command":"echo hi"}`
	seedAutomationWithStepType(t, automations, "tenant-1", "auto-1", domain.StepTypeShell, stepConfig)

	ctx := withTenant(context.Background(), "tenant-1")
	if _, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(executor.calls) != 1 {
		t.Fatalf("expected exactly 1 call, got %d", len(executor.calls))
	}
	if executor.calls[0].StepType != domain.StepTypeShell {
		t.Errorf("expected the stored step_type=shell to be dispatched, got %v", executor.calls[0].StepType)
	}
	if executor.calls[0].StepConfigJSON != stepConfig {
		t.Errorf("expected step_config_json to be passed through unchanged, got %q", executor.calls[0].StepConfigJSON)
	}
}

func TestRunNow_DefaultsTriggerToManualWhenUnset(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{}`}}
	uc := NewRunNow(automations, runs, executor)

	seedAutomation(t, automations, "tenant-1", "auto-1", `{"step_type":"agent"}`)
	ctx := withTenant(context.Background(), "tenant-1")

	run, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run.Trigger != domain.RunTriggerManual {
		t.Errorf("expected Trigger to default to manual, got %v", run.Trigger)
	}
}

func TestRunNow_RecordsProvidedTrigger(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{}`}}
	uc := NewRunNow(automations, runs, executor)

	seedAutomation(t, automations, "tenant-1", "auto-1", `{"step_type":"agent"}`)
	ctx := withTenant(context.Background(), "tenant-1")

	run, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1", Trigger: domain.RunTriggerScheduled})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run.Trigger != domain.RunTriggerScheduled {
		t.Errorf("expected Trigger to be recorded as scheduled, got %v", run.Trigger)
	}
}

func TestRunNow_IdempotentRetrySameRequestIDDoesNotDuplicateOrRecall(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{}`}}
	uc := NewRunNow(automations, runs, executor)

	seedAutomation(t, automations, "tenant-1", "auto-1", `{"step_type":"agent"}`)

	ctx := withTenant(context.Background(), "tenant-1")
	first, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-dup"})
	if err != nil {
		t.Fatalf("unexpected error on first call: %v", err)
	}

	second, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-dup"})
	if err != nil {
		t.Fatalf("unexpected error on retried call: %v", err)
	}

	if first.ID != second.ID {
		t.Errorf("expected the retried call to return the same run, got %q and %q", first.ID, second.ID)
	}
	if runs.created != 1 {
		t.Errorf("expected exactly 1 run to be created despite 2 RunNow calls, got %d", runs.created)
	}
	if len(executor.calls) != 1 {
		t.Errorf("expected exactly 1 call to WorkflowStepExecutor despite 2 RunNow calls, got %d", len(executor.calls))
	}
}

func TestRunNow_DifferentRequestIDsCreateDistinctRuns(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{}`}}
	uc := NewRunNow(automations, runs, executor)

	seedAutomation(t, automations, "tenant-1", "auto-1", `{"step_type":"shell"}`)
	ctx := withTenant(context.Background(), "tenant-1")

	if _, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-a"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-b"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if runs.created != 2 {
		t.Errorf("expected 2 distinct runs for 2 distinct request_ids, got %d", runs.created)
	}
	if len(executor.calls) != 2 {
		t.Errorf("expected 2 calls to WorkflowStepExecutor, got %d", len(executor.calls))
	}
}

// TestRunNow_WorkflowServiceFailurePropagatesAndRunRecordedFailed —
// TASK-BE-AUTO-004's rewire changed HOW a workflow-service transport
// failure propagates, deliberately: before the rewire, RunNow.Execute
// returned a Go error directly from the failed ExecuteAdHocStep call
// (distinct from a business-level "failed" status result, which returned
// (run, nil)). After the rewire, EVERY dispatch outcome — transport
// failure, business failure, or success — resolves through
// ExecuteAutomationChain to (run, nil); the failure surfaces in the run's
// own ActionResults[].Error/Status, not as a returned Go error, UNLESS
// something fails persisting the run's OWN state (a different failure
// class this test doesn't exercise). This is NOT "silently swallowed" the
// way TS's skipped_unavailable was — the run is recorded Failed with a
// non-empty error message, fully visible via ListRuns — it just surfaces
// through the run record instead of the RunNow gRPC call's own status
// code. See RunNow's doc comment for the full reasoning.
func TestRunNow_WorkflowServiceFailurePropagatesAndRunRecordedFailed(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{err: errors.New("workflow-service unreachable")}
	uc := NewRunNow(automations, runs, executor)

	seedAutomation(t, automations, "tenant-1", "auto-1", `{"step_type":"agent"}`)
	ctx := withTenant(context.Background(), "tenant-1")

	run, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1"})
	if err != nil {
		t.Fatalf("unexpected error — a dispatch failure is recorded on the run, not returned as a RunNow error: %v", err)
	}
	if run.Status != domain.RunStatusFailed {
		t.Errorf("expected run status Failed, got %v", run.Status)
	}
	if len(run.ActionResults) != 1 || run.ActionResults[0].Error == "" {
		t.Errorf("expected a non-empty error on the action result — the failure must remain visible, not silently swallowed, got %+v", run.ActionResults)
	}

	// The run row must still exist, recorded Failed — never silently
	// swallowed the way TS's skipped_unavailable was, per
	// automation-service.md §8/§10.
	found := false
	for _, r := range runs.byID {
		if r.AutomationID == "auto-1" && r.RequestID == "req-1" {
			found = true
			if r.Status != domain.RunStatusFailed {
				t.Errorf("expected the run to be recorded Failed, got %v", r.Status)
			}
		}
	}
	if !found {
		t.Fatal("expected a run row to exist even though the workflow-service call failed")
	}
}

// TestRunNow_WithPullRequestCreator_DispatchesCreatePrAction — TASK-BE-AUTO-004's
// rewire also wired RunNowOption/WithPullRequestCreator so cmd/server/main.go
// could pass a real PullRequestCreator into RunNow's internally-built
// ExecuteAutomationChain (previously always nil, meaning create_pr actions
// dispatched via RunNow always failed with "no PullRequestCreator
// configured" — see ExecuteAutomationChain.dispatchCreatePR). This test
// confirms the option actually reaches the chain.
func TestRunNow_WithPullRequestCreator_DispatchesCreatePrAction(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{}
	prs := &fakePullRequestCreator{output: CreatePullRequestOutput{URL: "https://example.com/pr/1", Number: 1}}
	uc := NewRunNow(automations, runs, executor, WithPullRequestCreator(prs))

	automation := seedAutomation(t, automations, "tenant-1", "auto-1", `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeCreatePR, ConfigJSON: `{"provider":"github","repo":"acme/widgets","title":"Weekly cleanup","headBranch":"automation/cleanup","baseBranch":"main"}`},
	}
	automations.byID[automation.ID] = automation

	ctx := withTenant(context.Background(), "tenant-1")
	run, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run.Status != domain.RunStatusSucceeded {
		t.Fatalf("expected run to succeed, got status=%v: %+v", run.Status, run.ActionResults)
	}
	if len(prs.calls) != 1 || prs.calls[0].Repo != "acme/widgets" {
		t.Errorf("expected PullRequestCreator to be called with the action's config, got %+v", prs.calls)
	}
	if len(executor.calls) != 0 {
		t.Errorf("create_pr must dispatch via PullRequestCreator, not WorkflowStepExecutor, got %d calls", len(executor.calls))
	}
}

// TestRunNow_WithoutPullRequestCreator_CreatePrActionFailsClearly confirms
// the pre-existing (unchanged) behavior when the option is omitted — every
// existing RunNow caller/test that doesn't pass WithPullRequestCreator.
func TestRunNow_WithoutPullRequestCreator_CreatePrActionFailsClearly(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{}
	uc := NewRunNow(automations, runs, executor)

	automation := seedAutomation(t, automations, "tenant-1", "auto-1", `{}`)
	automation.Actions = []domain.AutomationAction{
		{ID: "a1", Type: domain.AutomationActionTypeCreatePR, ConfigJSON: `{"provider":"github","repo":"acme/widgets","title":"x","headBranch":"h","baseBranch":"main"}`},
	}
	automations.byID[automation.ID] = automation

	ctx := withTenant(context.Background(), "tenant-1")
	run, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if run.Status != domain.RunStatusFailed {
		t.Fatalf("expected run to fail clearly (no PullRequestCreator configured), got status=%v", run.Status)
	}
}

func TestRunNow_WorkflowServiceReportedFailureRecordsFailedRunWithoutError(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{result: ExecuteAdHocStepOutput{Status: "failed", OutputJSON: `{"error":"step failed"}`}}
	uc := NewRunNow(automations, runs, executor)

	seedAutomation(t, automations, "tenant-1", "auto-1", `{"step_type":"agent"}`)
	ctx := withTenant(context.Background(), "tenant-1")

	run, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: "req-1"})
	if err != nil {
		t.Fatalf("unexpected error — a business-level step failure is not a RunNow error: %v", err)
	}
	if run.Status != domain.RunStatusFailed {
		t.Errorf("expected run status Failed, got %v", run.Status)
	}
}

func TestRunNow_RequiresTenantContext(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{}
	uc := NewRunNow(automations, runs, executor)

	_, err := uc.Execute(context.Background(), RunNowInput{AutomationID: "auto-1", RequestID: "req-1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestRunNow_RequiresRequestID(t *testing.T) {
	automations := newFakeAutomationRepository()
	runs := newFakeAutomationRunRepository()
	executor := &fakeWorkflowStepExecutor{}
	uc := NewRunNow(automations, runs, executor)

	seedAutomation(t, automations, "tenant-1", "auto-1", `{"step_type":"agent"}`)
	ctx := withTenant(context.Background(), "tenant-1")

	_, err := uc.Execute(ctx, RunNowInput{AutomationID: "auto-1", RequestID: ""})
	if err == nil {
		t.Fatal("expected an error when request_id is empty")
	}
	if len(executor.calls) != 0 {
		t.Error("expected WorkflowStepExecutor to never be called without a request_id")
	}
}
