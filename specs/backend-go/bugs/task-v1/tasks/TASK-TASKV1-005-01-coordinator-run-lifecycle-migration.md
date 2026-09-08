# TASK-TASKV1-005-01: Migration `0004_coordinator_run_lifecycle` — add `worktree_id`/`result`/`error_message`/`reported_at` to `coordinator_runs`

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (schema only)
**File:** `backend-go/services/orchestration-service/migrations/0004_coordinator_run_lifecycle.up.sql`, `.down.sql` (new)
**Depends on:** none — first task in this breakdown, everything else reads/writes these columns
**Status:** `[ ]` TODO

---

## Context

`orchestration.coordinator_runs` (`migrations/0001_init.up.sql:8-22`) already
exists with `id, tenant_id, origin_task_id, spec, status, coordinator_handle,
poll_interval_ms, created_at, completed_at` — confirmed by reading the file
directly. It has no column for the caller-supplied `worktree_id`, no place
to store a completed run's `result`/a failed run's `error_message`, and no
way to tell whether a terminal run's outcome has already been reported back
to `task-service`. This task adds exactly those four columns, following the
additive-migration pattern `0002_dispatch_context_user_id.up.sql` and
`0003_dispatch_context_worktree_id.up.sql` already established in this same
service (nullable `ADD COLUMN`, no backfill, a paired partial-index `.down.sql`
that drops cleanly).

No other table needs a migration: every column
`TASK-TASKV1-005-05`/`-06`/`-07`/`-10`'s usecases and repository methods read
or write on `orchestration_tasks`/`dispatch_contexts`/`decision_gates`
already exists (confirmed against `migrations/0001_init.up.sql:24-95`).

## Changes to make

Create `backend-go/services/orchestration-service/migrations/0004_coordinator_run_lifecycle.up.sql`:

```sql
-- worktree_id/result/error_message/reported_at close the lifecycle gap
-- BUG-TASKV1-005 identifies: StartCoordinatorRun/CompleteCoordinatorRun/
-- FailCoordinatorRun all need a column to write into that doesn't exist
-- yet. reported_at additionally lets a retry pass (see
-- TASK-TASKV1-005-07) find a run whose terminal state was persisted but
-- never successfully reported back to task-service.
ALTER TABLE orchestration.coordinator_runs
  ADD COLUMN worktree_id   TEXT,        -- optional, same nullable pattern as dispatch_contexts.worktree_id (0003)
  ADD COLUMN result        JSONB,       -- set by CompleteCoordinatorRun / the UpdateTaskStatusAndPromote run-finalization tail
  ADD COLUMN error_message TEXT,        -- set by FailCoordinatorRun
  ADD COLUMN reported_at   TIMESTAMPTZ; -- set once TaskServiceReporter.ReportResult succeeds

CREATE INDEX idx_coordinator_runs_unreported
  ON orchestration.coordinator_runs (status)
  WHERE status IN ('completed', 'failed') AND reported_at IS NULL;
```

Create `backend-go/services/orchestration-service/migrations/0004_coordinator_run_lifecycle.down.sql`:

```sql
DROP INDEX IF EXISTS orchestration.idx_coordinator_runs_unreported;
ALTER TABLE orchestration.coordinator_runs
  DROP COLUMN IF EXISTS reported_at,
  DROP COLUMN IF EXISTS error_message,
  DROP COLUMN IF EXISTS result,
  DROP COLUMN IF EXISTS worktree_id;
```

## Verify

```bash
cd /opt/repos/orca/backend-go/services/orchestration-service
# whatever migration-runner this service's Makefile/README already documents, e.g.:
migrate -path migrations -database "$DATABASE_DSN" up
migrate -path migrations -database "$DATABASE_DSN" down 1  # confirm the down migration is clean, then re-apply up
```

Expected: `\d orchestration.coordinator_runs` in `psql` shows all four new
columns; `idx_coordinator_runs_unreported` exists and its `WHERE` clause
matches verbatim (used by `TASK-TASKV1-005-07`'s retry-scan query); `down`
then `up` again leaves the table in the same final shape with no orphaned
index.
