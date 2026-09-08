# TASK-FT-001-01: Migration — `task.execution_links` table + `active_execution_link_id`/`workflow_template_id` columns

**From Solution:** BE-SOL-001
**Priority:** P0
**Service:** `task-service`
**File:** `backend-go/services/task-service/migrations/0003_execution_links.up.sql` (new), `backend-go/services/task-service/migrations/0003_execution_links.down.sql` (new)
**Depends on:** None to start, but see the numbering/collision check in Context before running this migration — **confirm whether TASK-TG-04-05 (SOL-TG-04)'s `active_execution_id` migration has already landed**, since both target the same "next migration" slot and a related-but-distinct column name.
**Status:** `[ ]` TODO

---

## Context

Verified against the real, current migrations directory
(`ls backend-go/services/task-service/migrations/`): only `0001_init` and
`0002_task_project_execution_tracking` exist today, so `0003` is genuinely
the next free number as of this writing.

**Collision this task must actively check for before running**: a sibling,
also-unimplemented task,
[`TASK-TG-04-05`](../../../../bugs/logic-v1/tasks/TASK-TG-04-05-report-task-execution-result.md)
(from `SOL-TG-04`), independently proposes adding a *different* column —
`task.tasks.active_execution_id TEXT` (a bare string, no FK) — to support
its own `ReportTaskExecutionResult` staleness check. That task's own doc
self-numbers its migration `0005` based on an assumed `TASK-TG-03-05`
migration `0004` that also does not exist in the real migrations directory
today — i.e. neither task's self-assigned migration number can be trusted;
only the real `ls` output at implementation time is authoritative.

This task's column is deliberately named `active_execution_link_id`
(pointing at the new `execution_links` table below, not a bare
coordinator-run string) specifically so it cannot collide byte-for-byte
with TASK-TG-04-05's `active_execution_id` even if both are eventually
implemented independently. But the two tasks can still collide on the
**migration file number** if implemented concurrently or out of order.
Before writing this migration:

1. Re-run `ls backend-go/services/task-service/migrations/` — if
   TASK-TG-04-05 (or anything else) has already claimed `0003`, renumber
   this migration to the real next-free number instead.
2. If TASK-TG-04-05 has already landed `active_execution_id` on
   `task.tasks`, do **not** also add a second, redundant tracking column —
   flag this in the PR description and coordinate with whoever owns that
   task; BE-SOL-001's own text explicitly anticipates this
   ("whichever of the two migrations lands second must not re-add a
   colliding column... if SOL-TG-04 is implemented first, its migration
   should be revised at that time to point at `execution_links` instead of
   inventing a second, redundant tracking column").
3. If neither has landed yet (current, verified state), proceed as below —
   this task's migration is safe to land first.

## Changes to make

`backend-go/services/task-service/migrations/0003_execution_links.up.sql`:

```sql
CREATE TABLE task.execution_links (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL,
    task_id           UUID NOT NULL REFERENCES task.tasks(id) ON DELETE CASCADE,
    engine            TEXT NOT NULL CHECK (engine IN ('direct_agent','orchestration','workflow')),
    external_ref_id   TEXT NOT NULL DEFAULT '', -- coordinator_run_id (Engine 2) / workflow execution_id (Engine 3, BE-SOL-002); empty for Engine 1
    status_mirror     TEXT NOT NULL DEFAULT 'in_progress', -- updated by BE-SOL-003's consumer for Engine 2/3, written directly here for Engine 1
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_execution_links_task ON task.execution_links (task_id, started_at DESC);

ALTER TABLE task.execution_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON task.execution_links
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE task.tasks
  ADD COLUMN active_execution_link_id UUID REFERENCES task.execution_links(id),
  ADD COLUMN workflow_template_id UUID; -- CR-FLOW-TASK-002 (BE-SOL-002) field; added here since selectEngine (TASK-FT-001-02) reads it — see BE-SOL-001's "Important grounding correction" section
```

`backend-go/services/task-service/migrations/0003_execution_links.down.sql`:

```sql
ALTER TABLE task.tasks
  DROP COLUMN IF EXISTS workflow_template_id,
  DROP COLUMN IF EXISTS active_execution_link_id;

DROP TABLE IF EXISTS task.execution_links;
```

`task.tasks.status`'s existing four-value CHECK constraint
(`domain/task.go:12-17`'s `StatusOpen`/`StatusInProgress`/`StatusDone`/
`StatusCancelled`) is untouched by this migration — this is additive-only
schema, not a status-machine redesign.

## Verify

```bash
cd /opt/repos/orca/backend-go
# Integration tests already apply every migration in this directory via
# testcontainers-go before running (see
# internal/adapter/postgres/repository_test.go:29-35's migrate CLI
# invocation) — a clean pass here means the migration applies cleanly.
go test ./services/task-service/internal/adapter/postgres/... -run TestRepository -v

# Manual up/down round-trip against a scratch DSN, if testcontainers/Docker
# isn't available in your environment:
migrate -path services/task-service/migrations -database "$DATABASE_DSN_TASK" up
migrate -path services/task-service/migrations -database "$DATABASE_DSN_TASK" down 1
```

Expected: migration applies cleanly on top of `0001`/`0002`; `down`
cleanly reverses it (drop order matters — columns before the table they
reference); no existing `task.tasks` row is affected (both new columns are
nullable, no default-required backfill).
