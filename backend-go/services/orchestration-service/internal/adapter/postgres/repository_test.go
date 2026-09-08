//go:build integration

// Integration tests run against a real Postgres via testcontainers-go, per
// specs/backend-go/standards/testing-strategy.md — gated behind the
// "integration" build tag so `go test ./...` (unit tests only) stays fast
// and Docker-free; run these explicitly with
// `go test -tags=integration ./internal/adapter/postgres/...`.
package postgres

import (
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/common/testutil"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/usecase"
)

func setupRepository(t *testing.T) *Repository {
	t.Helper()
	dsn := testutil.StartPostgres(t, "orchestration")

	migrationsPath, err := filepath.Abs("../../../migrations")
	if err != nil {
		t.Fatalf("resolving migrations path: %v", err)
	}
	// Uses the golang-migrate CLI directly rather than importing the
	// library, keeping this test's dependency footprint minimal — swap for
	// the library-based runner once the shared migration-runner helper
	// (referenced in architecture/05-data-architecture.md) exists in common/.
	cmd := exec.Command("migrate", "-path", migrationsPath, "-database", dsn, "up")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("running migrations: %v\n%s", err, out)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connecting to postgres: %v", err)
	}
	t.Cleanup(pool.Close)

	return New(pool)
}

func seedCoordinatorRun(t *testing.T, repo *Repository, pool *pgxpool.Pool, tenantID, id, handle string) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO orchestration.coordinator_runs (id, tenant_id, origin_task_id, coordinator_handle)
		VALUES ($1, $2, 'origin-task-1', $3)
	`, id, tenantID, handle)
	if err != nil {
		t.Fatalf("seeding coordinator run: %v", err)
	}
}

func TestRepository_UpdateStatusAndPromote_PromotesReadySiblingsAtomically(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()
	tenantID := "11111111-1111-1111-1111-111111111111"
	runID := "22222222-2222-2222-2222-222222222222"

	seedCoordinatorRun(t, repo, repo.pool, tenantID, runID, "coord-1")

	root, err := domain.NewOrchestrationTask("", tenantID, runID, "", "", "root", nil, nil)
	if err != nil {
		t.Fatalf("building root: %v", err)
	}
	root, err = repo.Create(ctx, root)
	if err != nil {
		t.Fatalf("creating root task: %v", err)
	}

	dependent, err := domain.NewOrchestrationTask("", tenantID, runID, "", "", "dependent", nil, []string{root.ID})
	if err != nil {
		t.Fatalf("building dependent: %v", err)
	}
	dependent, err = repo.Create(ctx, dependent)
	if err != nil {
		t.Fatalf("creating dependent task: %v", err)
	}

	updated, promoted, err := repo.UpdateStatusAndPromote(ctx, tenantID, root.ID, domain.TaskStatusCompleted)
	if err != nil {
		t.Fatalf("UpdateStatusAndPromote: %v", err)
	}
	if updated.Status != domain.TaskStatusCompleted {
		t.Errorf("expected root completed, got %s", updated.Status)
	}
	if len(promoted) != 1 || promoted[0] != dependent.ID {
		t.Fatalf("expected dependent promoted, got %v", promoted)
	}

	got, err := repo.Get(ctx, tenantID, dependent.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Status != domain.TaskStatusReady {
		t.Errorf("expected dependent status ready, got %s", got.Status)
	}
}

func TestRepository_ResolveGate_CannotBeResolvedTwice(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()
	tenantID := "33333333-3333-3333-3333-333333333333"
	runID := "44444444-4444-4444-4444-444444444444"

	seedCoordinatorRun(t, repo, repo.pool, tenantID, runID, "coord-2")

	task, err := domain.NewOrchestrationTask("", tenantID, runID, "", "", "gated task", nil, nil)
	if err != nil {
		t.Fatalf("building task: %v", err)
	}
	task, err = repo.Create(ctx, task)
	if err != nil {
		t.Fatalf("creating task: %v", err)
	}

	dc, err := repo.CreateDispatchContext(ctx, tenantID, "user-1", "", "handle-1", runID, task.ID)
	if err != nil {
		t.Fatalf("creating dispatch context: %v", err)
	}

	gate, err := repo.CreateGate(ctx, tenantID, dc.ID, "proceed?", []string{"yes", "no"})
	if err != nil {
		t.Fatalf("CreateGate: %v", err)
	}

	if _, _, err := repo.ResolveGate(ctx, tenantID, gate.ID, "yes"); err != nil {
		t.Fatalf("first ResolveGate: %v", err)
	}

	if _, _, err := repo.ResolveGate(ctx, tenantID, gate.ID, "no"); err == nil {
		t.Fatal("expected an error resolving an already-resolved gate")
	}
}

// TestRepository_CreateGate_SucceedsWhenDispatchContextHasTask is the
// concrete proof that Epic C's proto extension (docs/execution-plan.md)
// closes the ORCH_DISPATCH_CONTEXT_NO_TASK gap: a dispatch context created
// with a real orchestration_task_id (now possible via the extended
// CreateDispatchContextRequest) lets CreateGate succeed and round-trip
// question/options, instead of failing closed.
func TestRepository_CreateGate_SucceedsWhenDispatchContextHasTask(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()
	tenantID := "55555555-5555-5555-5555-555555555555"
	runID := "66666666-6666-6666-6666-666666666666"

	seedCoordinatorRun(t, repo, repo.pool, tenantID, runID, "coord-3")

	task, err := domain.NewOrchestrationTask("", tenantID, runID, "", "", "gated task", nil, nil)
	if err != nil {
		t.Fatalf("building task: %v", err)
	}
	task, err = repo.Create(ctx, task)
	if err != nil {
		t.Fatalf("creating task: %v", err)
	}

	dc, err := repo.CreateDispatchContext(ctx, tenantID, "user-1", "", "handle-1", runID, task.ID)
	if err != nil {
		t.Fatalf("creating dispatch context: %v", err)
	}
	if dc.OrchestrationTaskID != task.ID {
		t.Fatalf("expected dispatch context orchestration_task_id %q, got %q", task.ID, dc.OrchestrationTaskID)
	}

	gate, err := repo.CreateGate(ctx, tenantID, dc.ID, "proceed?", []string{"yes", "no"})
	if err != nil {
		t.Fatalf("expected CreateGate to succeed for a dispatch context with a task, got: %v", err)
	}
	if gate.OrchestrationTaskID != task.ID {
		t.Errorf("expected gate.OrchestrationTaskID %q, got %q", task.ID, gate.OrchestrationTaskID)
	}
	if gate.Question != "proceed?" {
		t.Errorf("expected question to round-trip, got %q", gate.Question)
	}
	if len(gate.Options) != 2 || gate.Options[0] != "yes" || gate.Options[1] != "no" {
		t.Errorf("expected options to round-trip, got %v", gate.Options)
	}

	got, err := repo.Get(ctx, tenantID, task.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Status != domain.TaskStatusBlocked {
		t.Errorf("expected task blocked by the gate, got %s", got.Status)
	}
}

// TestRepository_CreateGate_FailsWhenDispatchContextHasNoTask keeps proving
// the original failure mode is a real invariant, not a bug: an ad-hoc
// coordinator-only dispatch context (legitimately created with no
// orchestration_task_id) must still make CreateGate fail closed with
// usecase.ErrDispatchContextHasNoTask (mapped to ORCH_DISPATCH_CONTEXT_NO_TASK
// / FailedPrecondition at the usecase layer).
func TestRepository_CreateGate_FailsWhenDispatchContextHasNoTask(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()
	tenantID := "77777777-7777-7777-7777-777777777777"
	runID := "88888888-8888-8888-8888-888888888888"

	seedCoordinatorRun(t, repo, repo.pool, tenantID, runID, "coord-4")

	dc, err := repo.CreateDispatchContext(ctx, tenantID, "user-1", "", "handle-1", runID, "")
	if err != nil {
		t.Fatalf("creating dispatch context: %v", err)
	}

	if _, err := repo.CreateGate(ctx, tenantID, dc.ID, "proceed?", []string{"yes", "no"}); !errors.Is(err, usecase.ErrDispatchContextHasNoTask) {
		t.Fatalf("expected usecase.ErrDispatchContextHasNoTask, got: %v", err)
	}
}

// TestRepository_GetLatestForTask_ReturnsMostRecentAfterRetry proves the
// "latest wins" contract GetDispatchContextForTask depends on: a task can
// accumulate more than one dispatch_contexts row across retries (§8's
// circuit-breaker note), and GetLatestForTask must return the most
// recently created one, not the first.
func TestRepository_GetLatestForTask_ReturnsMostRecentAfterRetry(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()
	tenantID := "99999999-9999-9999-9999-999999999999"
	runID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

	seedCoordinatorRun(t, repo, repo.pool, tenantID, runID, "coord-5")

	task, err := domain.NewOrchestrationTask("", tenantID, runID, "", "", "retried task", nil, nil)
	if err != nil {
		t.Fatalf("building task: %v", err)
	}
	task, err = repo.Create(ctx, task)
	if err != nil {
		t.Fatalf("creating task: %v", err)
	}

	first, err := repo.CreateDispatchContext(ctx, tenantID, "user-1", "", "handle-a", runID, task.ID)
	if err != nil {
		t.Fatalf("create first dispatch context: %v", err)
	}
	_ = first
	time.Sleep(10 * time.Millisecond) // ensure created_at strictly orders the second row after the first
	second, err := repo.CreateDispatchContext(ctx, tenantID, "user-1", "", "handle-b", runID, task.ID)
	if err != nil {
		t.Fatalf("create second (retry) dispatch context: %v", err)
	}

	got, err := repo.GetLatestForTask(ctx, tenantID, task.ID)
	if err != nil {
		t.Fatalf("get latest for task: %v", err)
	}
	if got.ID != second.ID {
		t.Errorf("want the later dispatch context (id=%s), got id=%s", second.ID, got.ID)
	}
}

func TestRepository_GetLatestForTask_NoRows_ReturnsErrDispatchContextNotFound(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()

	_, err := repo.GetLatestForTask(ctx, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "cccccccc-cccc-cccc-cccc-cccccccccccc")
	if !errors.Is(err, usecase.ErrDispatchContextNotFound) {
		t.Fatalf("want ErrDispatchContextNotFound, got %v", err)
	}
}

// TestRepository_ListActiveDispatchContextsForUser_ReturnsOnlyCallerNonTerminal
// covers CR-STORAGE-006/007's real need: does the query correctly scope by
// (tenant_id, user_id) AND exclude terminal statuses. Avoids
// orchestration_tasks entirely (orchestrationTaskID="") since dispatch
// contexts are legitimately task-less (ad-hoc coordinator-only dispatch,
// per CreateDispatchContext's own doc comment) and task creation isn't
// what this test needs to exercise.
func TestRepository_ListActiveDispatchContextsForUser_ReturnsOnlyCallerNonTerminal(t *testing.T) {
	repo := setupRepository(t)
	ctx := context.Background()
	tenantID := "11111111-1111-1111-1111-111111111111"
	otherTenantID := "22222222-2222-2222-2222-222222222222"
	runID := "33333333-3333-3333-3333-333333333333"
	otherTenantRunID := "44444444-4444-4444-4444-444444444444"

	seedCoordinatorRun(t, repo, repo.pool, tenantID, runID, "coord-list-1")
	seedCoordinatorRun(t, repo, repo.pool, otherTenantID, otherTenantRunID, "coord-list-2")

	// Active, this user, this tenant — should be returned.
	active, err := repo.CreateDispatchContext(ctx, tenantID, "user-a", "", "handle-active", runID, "")
	if err != nil {
		t.Fatalf("create active dispatch context: %v", err)
	}

	// Completed, this user, this tenant — terminal, should be excluded.
	completed, err := repo.CreateDispatchContext(ctx, tenantID, "user-a", "", "handle-completed", runID, "")
	if err != nil {
		t.Fatalf("create completed dispatch context: %v", err)
	}
	if _, err := repo.pool.Exec(ctx, `UPDATE orchestration.dispatch_contexts SET status = 'completed' WHERE id = $1`, completed.ID); err != nil {
		t.Fatalf("marking dispatch context completed: %v", err)
	}

	// Active, DIFFERENT user, same tenant — should be excluded.
	if _, err := repo.CreateDispatchContext(ctx, tenantID, "user-b", "", "handle-other-user", runID, ""); err != nil {
		t.Fatalf("create other-user dispatch context: %v", err)
	}

	// Active, same user id string, DIFFERENT tenant — should be excluded
	// (tenant isolation must not leak across the user_id filter alone).
	if _, err := repo.CreateDispatchContext(ctx, otherTenantID, "user-a", "", "handle-other-tenant", otherTenantRunID, ""); err != nil {
		t.Fatalf("create other-tenant dispatch context: %v", err)
	}

	got, err := repo.ListActiveDispatchContextsForUser(ctx, tenantID, "user-a")
	if err != nil {
		t.Fatalf("list active dispatch contexts for user: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want exactly 1 active dispatch context, got %d: %+v", len(got), got)
	}
	if got[0].ID != active.ID {
		t.Errorf("want the active dispatch context (id=%s), got id=%s", active.ID, got[0].ID)
	}
	if got[0].UserID != "user-a" {
		t.Errorf("want UserID=user-a, got %q", got[0].UserID)
	}
}
