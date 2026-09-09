//go:build integration

// Integration tests run against a real Postgres via testcontainers-go, per
// specs/backend-go/standards/testing-strategy.md — gated behind the
// "integration" build tag so `go test ./...` (unit tests only) stays fast
// and Docker-free; run these explicitly with
// `go test -tags=integration ./internal/adapter/postgres/...`.
package postgres

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/common/testutil"
	"github.com/stablyai/orca-go/services/automation-service/internal/domain"
)

func setupRepositories(t *testing.T) (*AutomationRepository, *AutomationRunRepository) {
	t.Helper()
	dsn := testutil.StartPostgres(t, "automation")

	migrationsPath, err := filepath.Abs("../../../migrations")
	if err != nil {
		t.Fatalf("resolving migrations path: %v", err)
	}
	// Uses the golang-migrate CLI directly rather than importing the
	// library, keeping this test's dependency footprint minimal — matches
	// usage-service's reference pattern.
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

	return NewAutomationRepository(pool), NewAutomationRunRepository(pool)
}

func TestAutomationRepository_CreateAndGet(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	a, err := domain.NewAutomation("00000000-0000-0000-0000-000000000001", "11111111-1111-1111-1111-111111111111", "nightly-report", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{"prompt":"summarize"}`, now, "UTC", true, now)
	if err != nil {
		t.Fatalf("building automation: %v", err)
	}
	a.NextRunAt = now
	if err := automations.Create(ctx, a); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := automations.Get(ctx, a.TenantID, a.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != a.Name || got.RRule != a.RRule {
		t.Errorf("expected round-tripped automation to match, got %+v", got)
	}
	if got.StepType != domain.StepTypeAgent {
		t.Errorf("expected round-tripped StepType=agent, got %v", got.StepType)
	}
	if !got.Enabled {
		t.Error("expected round-tripped Enabled=true")
	}
	if got.Timezone != "UTC" {
		t.Errorf("expected round-tripped Timezone=UTC, got %q", got.Timezone)
	}
	if !got.NextRunAt.Equal(now) {
		t.Errorf("expected round-tripped NextRunAt=%v, got %v", now, got.NextRunAt)
	}
}

func TestAutomationRepository_ClaimDue_LocksAndAdvancesNextRunAt(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	due := mustNewAutomation(t, "00000000-0000-0000-0000-0000000000d1", "11111111-1111-1111-1111-111111111111", now.Add(-time.Minute))
	notYetDue := mustNewAutomation(t, "00000000-0000-0000-0000-0000000000f1", "11111111-1111-1111-1111-111111111111", now.Add(time.Hour))
	disabled := mustNewAutomation(t, "00000000-0000-0000-0000-0000000000d2", "11111111-1111-1111-1111-111111111111", now.Add(-time.Minute))
	disabled.Enabled = false

	for _, a := range []domain.Automation{due, notYetDue, disabled} {
		if err := automations.Create(ctx, a); err != nil {
			t.Fatalf("create automation %s: %v", a.ID, err)
		}
	}

	batch, err := automations.ClaimDue(ctx, now, 10)
	if err != nil {
		t.Fatalf("claim due: %v", err)
	}
	claimed := batch.Automations()
	if len(claimed) != 1 || claimed[0].ID != "00000000-0000-0000-0000-0000000000d1" {
		t.Fatalf("expected only the due, enabled automation to be claimed, got %+v", claimed)
	}

	next := now.Add(24 * time.Hour)
	if err := batch.Advance(ctx, "00000000-0000-0000-0000-0000000000d1", next, true); err != nil {
		t.Fatalf("advance: %v", err)
	}
	if err := batch.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	got, err := automations.Get(ctx, due.TenantID, "00000000-0000-0000-0000-0000000000d1")
	if err != nil {
		t.Fatalf("get after claim: %v", err)
	}
	if !got.NextRunAt.Equal(next) {
		t.Errorf("expected NextRunAt advanced to %v, got %v", next, got.NextRunAt)
	}
}

func TestAutomationRepository_ClaimDue_SkipsRowsLockedByAnotherClaim(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	due := mustNewAutomation(t, "00000000-0000-0000-0000-0000000000d1", "11111111-1111-1111-1111-111111111111", now.Add(-time.Minute))
	if err := automations.Create(ctx, due); err != nil {
		t.Fatalf("create automation: %v", err)
	}

	// Simulate a second replica's concurrent tick: the first ClaimDue's
	// transaction is still open (not committed/rolled back yet), holding
	// the row lock — a second ClaimDue call must SKIP LOCKED past it
	// instead of blocking or double-claiming, per automation-service.md §7.
	firstBatch, err := automations.ClaimDue(ctx, now, 10)
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	if len(firstBatch.Automations()) != 1 {
		t.Fatalf("expected the first claim to lock the due row, got %d", len(firstBatch.Automations()))
	}

	secondBatch, err := automations.ClaimDue(ctx, now, 10)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if len(secondBatch.Automations()) != 0 {
		t.Errorf("expected the second concurrent claim to skip the locked row, got %d", len(secondBatch.Automations()))
	}
	if err := secondBatch.Rollback(ctx); err != nil {
		t.Fatalf("rollback second batch: %v", err)
	}
	if err := firstBatch.Rollback(ctx); err != nil {
		t.Fatalf("rollback first batch: %v", err)
	}
}

func mustNewAutomation(t *testing.T, id, tenantID string, nextRunAt time.Time) domain.Automation {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	a, err := domain.NewAutomation(id, tenantID, "nightly-report", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{"prompt":"summarize"}`, now, "UTC", true, now)
	if err != nil {
		t.Fatalf("building automation: %v", err)
	}
	a.NextRunAt = nextRunAt
	return a
}

func TestAutomationRunRepository_FindByRequestID_IsIdempotencyBackstop(t *testing.T) {
	automations, runs := setupRepositories(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	a, _ := domain.NewAutomation("00000000-0000-0000-0000-000000000001", "11111111-1111-1111-1111-111111111111", "nightly-report", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{"prompt":"summarize"}`, now, "UTC", true, now)
	if err := automations.Create(ctx, a); err != nil {
		t.Fatalf("create automation: %v", err)
	}

	run, err := domain.NewPendingRun("00000000-0000-0000-0000-000000000101", a.ID, a.TenantID, "req-1", domain.StepTypeAgent, domain.RunTriggerManual, a.StepConfigJSON, now)
	if err != nil {
		t.Fatalf("building run: %v", err)
	}
	if err := runs.Create(ctx, run); err != nil {
		t.Fatalf("create run: %v", err)
	}

	// A second Create with the same (tenant_id, request_id) must violate the
	// unique index — the DB-level idempotency backstop from
	// automation-service.md §8.
	dup, _ := domain.NewPendingRun("00000000-0000-0000-0000-000000000102", a.ID, a.TenantID, "req-1", domain.StepTypeAgent, domain.RunTriggerManual, a.StepConfigJSON, now)
	if err := runs.Create(ctx, dup); err == nil {
		t.Fatal("expected a unique constraint violation for a duplicate (tenant_id, request_id)")
	}

	found, ok, err := runs.FindByRequestID(ctx, a.TenantID, a.ID, "req-1")
	if err != nil {
		t.Fatalf("find by request id: %v", err)
	}
	if !ok || found.ID != "00000000-0000-0000-0000-000000000101" {
		t.Errorf("expected to find run r1, got found=%v ok=%v", found, ok)
	}
}

// TestAutomationRunRepository_ListByAutomation_EmptyAutomationIDListsAllTenantRuns
// covers the Automation page's initial page-load call, which has no
// automation selected yet and calls ListByAutomation with automationID="" —
// live-reproduced as AUTOMATION_LIST_RUNS_FAILED: Postgres rejected "" bound
// against the uuid-typed automation_id column before this fix.
func TestAutomationRunRepository_ListByAutomation_EmptyAutomationIDListsAllTenantRuns(t *testing.T) {
	automations, runs := setupRepositories(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	tenantID := "11111111-1111-1111-1111-111111111111"

	a1, _ := domain.NewAutomation("00000000-0000-0000-0000-0000000000a1", tenantID, "job-1", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{}`, now, "UTC", true, now)
	a2, _ := domain.NewAutomation("00000000-0000-0000-0000-0000000000a2", tenantID, "job-2", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{}`, now, "UTC", true, now)
	if err := automations.Create(ctx, a1); err != nil {
		t.Fatalf("create automation 1: %v", err)
	}
	if err := automations.Create(ctx, a2); err != nil {
		t.Fatalf("create automation 2: %v", err)
	}

	run1, _ := domain.NewPendingRun("00000000-0000-0000-0000-000000000201", a1.ID, tenantID, "req-a1", domain.StepTypeAgent, domain.RunTriggerManual, a1.StepConfigJSON, now)
	run2, _ := domain.NewPendingRun("00000000-0000-0000-0000-000000000202", a2.ID, tenantID, "req-a2", domain.StepTypeAgent, domain.RunTriggerManual, a2.StepConfigJSON, now)
	if err := runs.Create(ctx, run1); err != nil {
		t.Fatalf("create run 1: %v", err)
	}
	if err := runs.Create(ctx, run2); err != nil {
		t.Fatalf("create run 2: %v", err)
	}

	// automationID="" — the real gap this test targets — must list runs
	// across both automations, not error on the empty-string uuid bind.
	got, _, err := runs.ListByAutomation(ctx, tenantID, "", "", 50)
	if err != nil {
		t.Fatalf("list all runs for tenant: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 runs across both automations, got %d", len(got))
	}

	// automationID scoped to a1 must still filter correctly.
	scoped, _, err := runs.ListByAutomation(ctx, tenantID, a1.ID, "", 50)
	if err != nil {
		t.Fatalf("list runs scoped to automation 1: %v", err)
	}
	if len(scoped) != 1 || scoped[0].ID != run1.ID {
		t.Fatalf("expected only run 1 scoped to automation 1, got %+v", scoped)
	}
}

// TestAutomationRunRepository_PruneRuns_KeepsOnlyMostRecentN covers
// TASK-BE-AUTO-010's retention behavior: given more runs than maxRuns,
// PruneRuns deletes everything but the maxRuns most recent by created_at.
func TestAutomationRunRepository_PruneRuns_KeepsOnlyMostRecentN(t *testing.T) {
	automations, runs := setupRepositories(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	tenantID := "11111111-1111-1111-1111-111111111111"

	a, _ := domain.NewAutomation("00000000-0000-0000-0000-0000000000c1", tenantID, "retained-job", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{}`, base, "UTC", true, base)
	if err := automations.Create(ctx, a); err != nil {
		t.Fatalf("create automation: %v", err)
	}

	// 5 runs, oldest to newest by created_at — request-00 is oldest,
	// request-04 is newest.
	runIDs := []string{
		"00000000-0000-0000-0000-000000000301",
		"00000000-0000-0000-0000-000000000302",
		"00000000-0000-0000-0000-000000000303",
		"00000000-0000-0000-0000-000000000304",
		"00000000-0000-0000-0000-000000000305",
	}
	for i, id := range runIDs {
		createdAt := base.Add(time.Duration(i) * time.Second)
		run, err := domain.NewPendingRun(id, a.ID, tenantID, fmt.Sprintf("req-%d", i), domain.StepTypeAgent, domain.RunTriggerManual, a.StepConfigJSON, createdAt)
		if err != nil {
			t.Fatalf("building run %d: %v", i, err)
		}
		if err := runs.Create(ctx, run); err != nil {
			t.Fatalf("create run %d: %v", i, err)
		}
	}

	if err := runs.PruneRuns(ctx, tenantID, a.ID, 2); err != nil {
		t.Fatalf("prune runs: %v", err)
	}

	remaining, _, err := runs.ListByAutomation(ctx, tenantID, a.ID, "", 50)
	if err != nil {
		t.Fatalf("list remaining runs: %v", err)
	}
	if len(remaining) != 2 {
		t.Fatalf("expected 2 remaining runs after prune, got %d: %+v", len(remaining), remaining)
	}
	remainingIDs := map[string]bool{}
	for _, r := range remaining {
		remainingIDs[r.ID] = true
	}
	// The 2 newest by created_at are runIDs[3] and runIDs[4].
	if !remainingIDs[runIDs[3]] || !remainingIDs[runIDs[4]] {
		t.Errorf("expected the 2 newest runs to survive prune, got %+v", remaining)
	}
}

// TestAutomationRunRepository_PruneRuns_ZeroOrNegativeIsNoop covers the
// port's documented "maxRuns <= 0 is a no-op" contract — callers resolve
// the "0 = default 100" policy themselves before calling PruneRuns.
func TestAutomationRunRepository_PruneRuns_ZeroOrNegativeIsNoop(t *testing.T) {
	automations, runs := setupRepositories(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	tenantID := "11111111-1111-1111-1111-111111111111"

	a, _ := domain.NewAutomation("00000000-0000-0000-0000-0000000000c2", tenantID, "untouched-job", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{}`, base, "UTC", true, base)
	if err := automations.Create(ctx, a); err != nil {
		t.Fatalf("create automation: %v", err)
	}
	run, _ := domain.NewPendingRun("00000000-0000-0000-0000-000000000401", a.ID, tenantID, "req-0", domain.StepTypeAgent, domain.RunTriggerManual, a.StepConfigJSON, base)
	if err := runs.Create(ctx, run); err != nil {
		t.Fatalf("create run: %v", err)
	}

	if err := runs.PruneRuns(ctx, tenantID, a.ID, 0); err != nil {
		t.Fatalf("prune runs (maxRuns=0): %v", err)
	}
	remaining, _, err := runs.ListByAutomation(ctx, tenantID, a.ID, "", 50)
	if err != nil {
		t.Fatalf("list remaining runs: %v", err)
	}
	if len(remaining) != 1 {
		t.Fatalf("expected PruneRuns(maxRuns=0) to be a no-op, got %d remaining", len(remaining))
	}
}

// TestAutomationRepository_AcquireRunLock_OnlyOneCallerWinsWhenUnlocked
// covers TASK-BE-AUTO-011's core guarantee against real Postgres: the
// conditional UPDATE either claims an unlocked row or, for a second racing
// caller, sees the first caller's just-written running_run_id and loses.
func TestAutomationRepository_AcquireRunLock_OnlyOneCallerWinsWhenUnlocked(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	tenantID := "11111111-1111-1111-1111-111111111111"

	a, _ := domain.NewAutomation("00000000-0000-0000-0000-0000000000d3", tenantID, "locked-job", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{}`, base, "UTC", true, base)
	if err := automations.Create(ctx, a); err != nil {
		t.Fatalf("create automation: %v", err)
	}

	first, err := automations.AcquireRunLock(ctx, tenantID, a.ID, "00000000-0000-0000-0000-000000000501", time.Hour)
	if err != nil {
		t.Fatalf("acquire (first): %v", err)
	}
	if !first {
		t.Fatal("expected the first caller to acquire the lock on an unlocked automation")
	}

	second, err := automations.AcquireRunLock(ctx, tenantID, a.ID, "00000000-0000-0000-0000-000000000502", time.Hour)
	if err != nil {
		t.Fatalf("acquire (second): %v", err)
	}
	if second {
		t.Fatal("expected the second caller to lose the race while the first still holds a fresh lock")
	}

	got, err := automations.Get(ctx, tenantID, a.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.RunningRunID != "00000000-0000-0000-0000-000000000501" {
		t.Errorf("RunningRunID = %q, want %q", got.RunningRunID, "00000000-0000-0000-0000-000000000501")
	}
}

// TestAutomationRepository_AcquireRunLock_StaleLockPastTTLSelfHeals covers
// the self-healing path: a lock older than ttl is reclaimable without any
// separate reaper process.
func TestAutomationRepository_AcquireRunLock_StaleLockPastTTLSelfHeals(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	tenantID := "11111111-1111-1111-1111-111111111111"

	a, _ := domain.NewAutomation("00000000-0000-0000-0000-0000000000d4", tenantID, "stale-lock-job", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{}`, base, "UTC", true, base)
	if err := automations.Create(ctx, a); err != nil {
		t.Fatalf("create automation: %v", err)
	}

	// Acquire with a 1-second TTL, then wait it out — faster than backdating
	// running_since via a second UPDATE, and exercises the real
	// `now() - make_interval(secs => $4)` comparison end to end.
	acquired, err := automations.AcquireRunLock(ctx, tenantID, a.ID, "00000000-0000-0000-0000-000000000503", time.Second)
	if err != nil || !acquired {
		t.Fatalf("acquire (crashed-run): acquired=%v err=%v", acquired, err)
	}
	time.Sleep(1200 * time.Millisecond)

	acquired, err = automations.AcquireRunLock(ctx, tenantID, a.ID, "00000000-0000-0000-0000-000000000504", time.Second)
	if err != nil {
		t.Fatalf("acquire (healed-run): %v", err)
	}
	if !acquired {
		t.Fatal("expected a lock older than its TTL to be reclaimable")
	}
}

// TestAutomationRepository_ReleaseRunLock_OnlyReleasesOwnLock covers the
// "don't release someone else's lock" guard.
func TestAutomationRepository_ReleaseRunLock_OnlyReleasesOwnLock(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	base := time.Now().UTC().Truncate(time.Second)
	tenantID := "11111111-1111-1111-1111-111111111111"

	a, _ := domain.NewAutomation("00000000-0000-0000-0000-0000000000d5", tenantID, "release-job", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{}`, base, "UTC", true, base)
	if err := automations.Create(ctx, a); err != nil {
		t.Fatalf("create automation: %v", err)
	}
	if _, err := automations.AcquireRunLock(ctx, tenantID, a.ID, "00000000-0000-0000-0000-000000000505", time.Hour); err != nil {
		t.Fatalf("acquire: %v", err)
	}

	// A stale caller trying to release a lock it no longer (or never) held
	// must be a no-op.
	if err := automations.ReleaseRunLock(ctx, tenantID, a.ID, "00000000-0000-0000-0000-000000000506"); err != nil {
		t.Fatalf("release (impostor): %v", err)
	}
	got, err := automations.Get(ctx, tenantID, a.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.RunningRunID != "00000000-0000-0000-0000-000000000505" {
		t.Fatalf("expected impostor's release to be a no-op, RunningRunID = %q, want %q", got.RunningRunID, "00000000-0000-0000-0000-000000000505")
	}

	if err := automations.ReleaseRunLock(ctx, tenantID, a.ID, "00000000-0000-0000-0000-000000000505"); err != nil {
		t.Fatalf("release (owner): %v", err)
	}
	got, err = automations.Get(ctx, tenantID, a.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.RunningRunID != "" {
		t.Errorf("expected RunningRunID cleared after the real owner released, got %q", got.RunningRunID)
	}
}

func TestAutomationRepository_List_ScopesToTenant(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()

	tenantA := "11111111-1111-1111-1111-111111111111"
	tenantB := "22222222-2222-2222-2222-222222222222"
	mustCreateAutomation(t, automations, "00000000-0000-0000-0000-0000000000a1", tenantA)
	mustCreateAutomation(t, automations, "00000000-0000-0000-0000-0000000000a2", tenantA)
	mustCreateAutomation(t, automations, "00000000-0000-0000-0000-0000000000b1", tenantB)

	got, _, err := automations.List(ctx, tenantA, "", 50)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 automations for tenant A, got %d", len(got))
	}
	for _, a := range got {
		if a.TenantID != tenantA {
			t.Errorf("expected only tenant A rows, got tenant_id=%q", a.TenantID)
		}
	}
}

func TestAutomationRepository_List_PaginatesWithoutDuplicatesOrGaps(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	tenantID := "11111111-1111-1111-1111-111111111111"

	ids := []string{
		"00000000-0000-0000-0000-000000000001",
		"00000000-0000-0000-0000-000000000002",
		"00000000-0000-0000-0000-000000000003",
		"00000000-0000-0000-0000-000000000004",
		"00000000-0000-0000-0000-000000000005",
	}
	for _, id := range ids {
		mustCreateAutomation(t, automations, id, tenantID)
	}

	seen := map[string]bool{}
	pageToken := ""
	for i := 0; i < 10; i++ { // bounded loop guards against an infinite-pagination bug
		page, next, err := automations.List(ctx, tenantID, pageToken, 2)
		if err != nil {
			t.Fatalf("list page: %v", err)
		}
		for _, a := range page {
			if seen[a.ID] {
				t.Fatalf("duplicate id %s returned across pages", a.ID)
			}
			seen[a.ID] = true
		}
		if next == "" {
			break
		}
		pageToken = next
	}
	if len(seen) != len(ids) {
		t.Fatalf("expected all %d automations covered across pages, got %d", len(ids), len(seen))
	}
}

func TestAutomationRepository_Update_PersistsFieldsAndFailsForWrongTenant(t *testing.T) {
	automations, _ := setupRepositories(t)
	ctx := context.Background()
	tenantA := "11111111-1111-1111-1111-111111111111"
	tenantB := "22222222-2222-2222-2222-222222222222"

	a := mustCreateAutomation(t, automations, "00000000-0000-0000-0000-0000000000c1", tenantA)
	a.Name = "renamed"
	a.Enabled = false
	if err := automations.Update(ctx, tenantA, a); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := automations.Get(ctx, tenantA, a.ID)
	if err != nil {
		t.Fatalf("get after update: %v", err)
	}
	if got.Name != "renamed" || got.Enabled {
		t.Errorf("expected the update to persist, got %+v", got)
	}

	// Updating tenant A's row while scoped to tenant B must affect 0 rows
	// and surface as an error — the tenant-isolation guarantee.
	a.Name = "should-not-persist"
	if err := automations.Update(ctx, tenantB, a); err == nil {
		t.Error("expected an error when updating another tenant's automation")
	}
}

func TestAutomationRepository_Delete_CascadesToRunsAndFailsForWrongTenant(t *testing.T) {
	automations, runs := setupRepositories(t)
	ctx := context.Background()
	tenantA := "11111111-1111-1111-1111-111111111111"
	tenantB := "22222222-2222-2222-2222-222222222222"

	a := mustCreateAutomation(t, automations, "00000000-0000-0000-0000-0000000000d2", tenantA)
	now := time.Now().UTC().Truncate(time.Second)
	run, err := domain.NewPendingRun("00000000-0000-0000-0000-000000000d1a", a.ID, tenantA, "req-cascade", domain.StepTypeAgent, domain.RunTriggerManual, a.StepConfigJSON, now)
	if err != nil {
		t.Fatalf("building run: %v", err)
	}
	if err := runs.Create(ctx, run); err != nil {
		t.Fatalf("create run: %v", err)
	}

	// Deleting tenant A's automation while scoped to tenant B must fail
	// (0 rows affected) and leave the row + its run intact.
	if err := automations.Delete(ctx, tenantB, a.ID); err == nil {
		t.Error("expected an error when deleting another tenant's automation")
	}

	if err := automations.Delete(ctx, tenantA, a.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := automations.Get(ctx, tenantA, a.ID); err == nil {
		t.Error("expected the automation to be gone after delete")
	}

	// ON DELETE CASCADE (migrations/0001_init.up.sql) must have removed the
	// automation_runs row too — checked with a direct SELECT against the
	// table, not through the repository API.
	var count int
	if err := automations.pool.QueryRow(ctx, `SELECT count(*) FROM automation.automation_runs WHERE id = $1`, run.ID).Scan(&count); err != nil {
		t.Fatalf("querying automation_runs directly: %v", err)
	}
	if count != 0 {
		t.Errorf("expected the run row to be cascade-deleted, found %d matching rows", count)
	}
}

func mustCreateAutomation(t *testing.T, repo *AutomationRepository, id, tenantID string) domain.Automation {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	a, err := domain.NewAutomation(id, tenantID, "nightly-report", "FREQ=DAILY;INTERVAL=1", domain.StepTypeAgent, `{"prompt":"summarize"}`, now, "UTC", true, now)
	if err != nil {
		t.Fatalf("building automation: %v", err)
	}
	if err := repo.Create(context.Background(), a); err != nil {
		t.Fatalf("create automation %s: %v", id, err)
	}
	return a
}
