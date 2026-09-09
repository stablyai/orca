package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
	"github.com/stablyai/orca-go/services/automation-service/internal/usecase"
)

// fakeAutomationRepository/fakeAutomationRunRepository/fakeWorkflowStepExecutor
// mirror internal/usecase's own test fakes (unexported there, so redefined
// here) — lets these tests build a real *usecase.RunNow instead of faking
// RunNow's own behavior a second time.
type fakeAutomationRepository struct {
	byID map[string]domain.Automation
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

// List/Update/Delete are unused by ticker_test.go's scenarios (the
// scheduler only ever Creates/Gets/ClaimDues) — stubbed only to satisfy
// usecase.AutomationRepository.
func (f *fakeAutomationRepository) List(ctx context.Context, tenantID, pageToken string, pageSize int32) ([]domain.Automation, string, error) {
	return nil, "", nil
}

func (f *fakeAutomationRepository) Update(ctx context.Context, tenantID string, a domain.Automation) error {
	f.byID[a.ID] = a
	return nil
}

func (f *fakeAutomationRepository) Delete(ctx context.Context, tenantID, id string) error {
	delete(f.byID, id)
	return nil
}

func (f *fakeAutomationRepository) AcquireRunLock(ctx context.Context, tenantID, automationID, runID string, ttl time.Duration) (bool, error) {
	return true, nil
}

func (f *fakeAutomationRepository) ReleaseRunLock(ctx context.Context, tenantID, automationID, runID string) error {
	return nil
}

type fakeAutomationRunRepository struct {
	byID map[string]domain.AutomationRun
}

func (f *fakeAutomationRunRepository) Create(ctx context.Context, run domain.AutomationRun) error {
	f.byID[run.ID] = run
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
	return nil, "", nil
}

func (f *fakeAutomationRunRepository) PruneRuns(ctx context.Context, tenantID, automationID string, maxRuns int32) error {
	return nil
}

type fakeWorkflowStepExecutor struct {
	calls []usecase.ExecuteAdHocStepInput
	err   error
}

func (f *fakeWorkflowStepExecutor) ExecuteAdHocStep(ctx context.Context, in usecase.ExecuteAdHocStepInput) (usecase.ExecuteAdHocStepOutput, error) {
	f.calls = append(f.calls, in)
	if f.err != nil {
		return usecase.ExecuteAdHocStepOutput{}, f.err
	}
	return usecase.ExecuteAdHocStepOutput{Status: "completed", OutputJSON: `{"ok":true}`}, nil
}

// fakeClaimer/fakeBatch are in-memory usecase.DueAutomationClaimer /
// usecase.ClaimedBatch fakes — the scheduler's tests never touch Postgres.
type fakeClaimer struct {
	batch     *fakeBatch
	claimErr  error
	claimedAt []time.Time // records each ClaimDue(now, ...) call's `now`
}

func (f *fakeClaimer) ClaimDue(ctx context.Context, now time.Time, limit int32) (usecase.ClaimedBatch, error) {
	f.claimedAt = append(f.claimedAt, now)
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	return f.batch, nil
}

type advanceCall struct {
	automationID string
	nextRunAt    time.Time
	hasNext      bool
}

type fakeBatch struct {
	automations []domain.Automation
	advanced    []advanceCall
	committed   bool
	rolledBack  bool
}

func (b *fakeBatch) Automations() []domain.Automation { return b.automations }

func (b *fakeBatch) Advance(ctx context.Context, automationID string, nextRunAt time.Time, hasNext bool) error {
	b.advanced = append(b.advanced, advanceCall{automationID: automationID, nextRunAt: nextRunAt, hasNext: hasNext})
	return nil
}

func (b *fakeBatch) Commit(ctx context.Context) error   { b.committed = true; return nil }
func (b *fakeBatch) Rollback(ctx context.Context) error { b.rolledBack = true; return nil }

func newRunNow(t *testing.T, automations *fakeAutomationRepository, executor *fakeWorkflowStepExecutor) *usecase.RunNow {
	t.Helper()
	return usecase.NewRunNow(automations, &fakeAutomationRunRepository{byID: map[string]domain.AutomationRun{}}, executor)
}

func seedDueAutomation(t *testing.T, id, tenantID string, nextRunAt time.Time) domain.Automation {
	t.Helper()
	now := nextRunAt.Add(-time.Hour)
	a, err := domain.NewAutomation(id, tenantID, "nightly-report", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{"prompt":"summarize"}`, now, "UTC", true, now)
	if err != nil {
		t.Fatalf("building automation: %v", err)
	}
	a.NextRunAt = nextRunAt
	return a
}

func TestTicker_DispatchesDueAutomationAndAdvancesNextRunAt(t *testing.T) {
	automations := &fakeAutomationRepository{byID: map[string]domain.Automation{}}
	executor := &fakeWorkflowStepExecutor{}
	runNow := newRunNow(t, automations, executor)

	due := seedDueAutomation(t, "auto-1", "tenant-1", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	automations.byID[due.ID] = due
	batch := &fakeBatch{automations: []domain.Automation{due}}
	claimer := &fakeClaimer{batch: batch}

	ticker := New(claimer, runNow, time.Minute, 10, nil)
	ticker.tick(context.Background())

	if len(executor.calls) != 1 {
		t.Fatalf("expected exactly 1 dispatch, got %d", len(executor.calls))
	}
	if executor.calls[0].TenantID != "tenant-1" {
		t.Errorf("expected dispatch to carry tenant_id=tenant-1, got %q", executor.calls[0].TenantID)
	}
	if !batch.committed {
		t.Error("expected the claim batch to be committed")
	}
	if len(batch.advanced) != 1 {
		t.Fatalf("expected next_run_at to be advanced once, got %d", len(batch.advanced))
	}
	if !batch.advanced[0].hasNext {
		t.Error("expected a daily rule to always have a next occurrence")
	}
	if !batch.advanced[0].nextRunAt.After(due.NextRunAt) {
		t.Errorf("expected the advanced next_run_at (%v) to be after the dispatched one (%v)", batch.advanced[0].nextRunAt, due.NextRunAt)
	}
}

func TestTicker_UsesDeterministicRequestIDForRetriedClaim(t *testing.T) {
	automations := &fakeAutomationRepository{byID: map[string]domain.Automation{}}
	executor := &fakeWorkflowStepExecutor{}
	runNow := newRunNow(t, automations, executor)

	due := seedDueAutomation(t, "auto-1", "tenant-1", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	automations.byID[due.ID] = due
	claimer := &fakeClaimer{batch: &fakeBatch{automations: []domain.Automation{due}}}
	ticker := New(claimer, runNow, time.Minute, 10, nil)

	// Two ticks "reclaiming" the same due occurrence (e.g. a retried tick,
	// or a second replica racing under partition) must dispatch with the
	// same request_id, so RunNow's idempotency check dedupes it — never a
	// second real workflow-service call, per automation-service.md §7/§8.
	ticker.tick(context.Background())
	ticker.tick(context.Background())

	if len(executor.calls) != 1 {
		t.Fatalf("expected the second reclaim to dedupe and skip a real dispatch, got %d calls", len(executor.calls))
	}
}

func TestTicker_DispatchFailureStillAdvancesNextRunAt(t *testing.T) {
	automations := &fakeAutomationRepository{byID: map[string]domain.Automation{}}
	executor := &fakeWorkflowStepExecutor{err: errors.New("workflow-service unreachable")}
	runNow := newRunNow(t, automations, executor)

	due := seedDueAutomation(t, "auto-1", "tenant-1", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	automations.byID[due.ID] = due
	batch := &fakeBatch{automations: []domain.Automation{due}}
	claimer := &fakeClaimer{batch: batch}
	ticker := New(claimer, runNow, time.Minute, 10, nil)

	ticker.tick(context.Background())

	// A workflow-service failure is recorded Failed by RunNow itself
	// (fail-closed, §8) — the scheduler must still advance the schedule so
	// this automation isn't reclaimed forever instead of reaching its next
	// real occurrence.
	if len(batch.advanced) != 1 {
		t.Fatalf("expected next_run_at to still be advanced despite a dispatch failure, got %d calls", len(batch.advanced))
	}
	if !batch.committed {
		t.Error("expected the claim batch to still be committed despite a dispatch failure")
	}
}

func TestTicker_NoDueAutomationsCommitsEmptyBatch(t *testing.T) {
	automations := &fakeAutomationRepository{byID: map[string]domain.Automation{}}
	executor := &fakeWorkflowStepExecutor{}
	runNow := newRunNow(t, automations, executor)

	batch := &fakeBatch{}
	claimer := &fakeClaimer{batch: batch}
	ticker := New(claimer, runNow, time.Minute, 10, nil)

	ticker.tick(context.Background())

	if len(executor.calls) != 0 {
		t.Errorf("expected no dispatch when nothing is due, got %d", len(executor.calls))
	}
	if !batch.committed {
		t.Error("expected an empty claim batch to still be committed")
	}
}

func TestTicker_ClaimFailureDoesNotPanic(t *testing.T) {
	automations := &fakeAutomationRepository{byID: map[string]domain.Automation{}}
	executor := &fakeWorkflowStepExecutor{}
	runNow := newRunNow(t, automations, executor)

	claimer := &fakeClaimer{claimErr: errors.New("db unavailable")}
	ticker := New(claimer, runNow, time.Minute, 10, nil)

	ticker.tick(context.Background()) // must not panic
	if len(executor.calls) != 0 {
		t.Errorf("expected no dispatch when claiming fails, got %d", len(executor.calls))
	}
}
