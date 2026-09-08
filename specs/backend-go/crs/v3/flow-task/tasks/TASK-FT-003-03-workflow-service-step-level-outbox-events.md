# TASK-FT-003-03: `workflow-service` step-level outbox events (`orca.workflow.step.completed`/`.failed`)

**From Solution:** BE-SOL-003
**Priority:** P1
**Service:** `workflow-service`
**File:** `backend-go/services/workflow-service/migrations/0008_outbox_events.up.sql` (new — number depends on TASK-FT-002-02 landing `0007` first, see Context), `backend-go/services/workflow-service/internal/domain/outbox_event.go` (new), `backend-go/services/workflow-service/internal/usecase/ports.go` (`StepExecutionRepository.UpdateStepExecution` widened), `backend-go/services/workflow-service/internal/usecase/wave_dispatcher.go` (`dispatchStep`), `backend-go/services/workflow-service/internal/adapter/postgres/repository.go` (`UpdateStepExecution` widened + `common/outbox.Store` impl), `backend-go/services/workflow-service/cmd/server/main.go` (wire `outbox.Relay`)
**Depends on:** TASK-FT-002-02 (claims migration `0007` first — this task's migration number must be re-checked at implementation time), TASK-FT-002-05 (`OriginTaskID` on `WorkflowExecution`, needed for the payload's `origin_task_id` field)
**Status:** `[ ]` TODO

---

## Context

Verified against the real, current `wave_dispatcher.go`: `dispatchStep`
(`:172-191`) already calls `d.stepExecutions.UpdateStepExecution(ctx,
se)` **twice** — once optimistically before running the step (`:174`,
marking it running), once with the final result after (`:183`, terminal):

```go
func (d *waveDispatcher) dispatchStep(ctx context.Context, step domain.Step, se domain.StepExecution) bool {
	se.MarkRunning()
	if err := d.stepExecutions.UpdateStepExecution(ctx, se); err != nil { /* ... */ }

	result, err := d.runStep(ctx, step, &se)

	if uerr := d.stepExecutions.UpdateStepExecution(ctx, se); uerr != nil { /* ... */ }
	// ...
}
```

The second call site (`:183`) is where this task adds the enqueue —
**same pattern as TASK-FT-003-01's correction**: widen
`UpdateStepExecution`'s signature to accept an optional
`domain.OutboxEvent`, built by the usecase, inserted by the repository
inside the SAME `UPDATE workflow.step_executions ...` statement's
transaction (confirmed real, current implementation:
`internal/adapter/postgres/repository.go:308-321`'s `UpdateStepExecution`
is a single `Exec`, no explicit transaction today — this task wraps it in
one, same as TASK-FT-003-01 did for `CreateDispatchContext`).

`workflow-service` has **no** `adapter/eventbus`/outbox package at all
today (confirmed: no such directory exists, and `cmd/server/main.go` has
no NATS/outbox wiring — see the real, current file). This task builds
that plumbing from scratch, following `usage-service`'s precedent
directly (same as TASK-FT-003-01 did for `orchestration-service`) rather
than SOL-PW-04's still-unimplemented sketch for this service's
execution-level events. If SOL-PW-04 is implemented first, this task's
two step-level subjects are added to its existing `Enqueue` call site
instead of building a parallel mechanism; if this task lands first,
SOL-PW-04's execution-level subjects (`orca.workflow.execution.completed`/
`.failed`, from `runToCompletion` — see
`specs/backend-go/bugs/logic-v1/tasks/TASK-PW-04-06-workflow-service-execute-enqueues-and-relay-wiring.md`,
also unimplemented) join the same `adapter/eventbus`/outbox plumbing this
task creates. Either order works because both write through the same
`internal/adapter/postgres` package.

**Migration numbering**: TASK-FT-002-02 claims `0007` for
`origin_task_id`. This task's outbox migration must check `ls
backend-go/services/workflow-service/migrations/` at implementation time
and use whatever is genuinely next-free — `0008` is this document's
best guess assuming TASK-FT-002-02 lands first per this README's
dependency order, not a guarantee.

## Changes to make

**1. Migration** (same shape as `usage.outbox_events`):

```sql
CREATE TABLE workflow.outbox_events (
    id            UUID PRIMARY KEY,
    tenant_id     UUID NOT NULL,
    subject       TEXT NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL,
    version       INT NOT NULL,
    payload       JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);
CREATE INDEX idx_workflow_outbox_events_unpublished
    ON workflow.outbox_events (created_at)
    WHERE published_at IS NULL;
```

**2. `internal/domain/outbox_event.go`** (new) — identical shape to
TASK-FT-003-01's `orchestration-service` version.

**3. `ports.go`** — widen `StepExecutionRepository`:

```go
UpdateStepExecution(ctx context.Context, se domain.StepExecution, event domain.OutboxEvent) error
```

Every existing call site of `UpdateStepExecution` (there are two, in
`dispatchStep`, plus `execute_ad_hoc_step.go` if it also calls this
method — confirm at implementation time) must pass a zero-value
`domain.OutboxEvent{}` when there is nothing to enqueue (the optimistic
`MarkRunning` call at `wave_dispatcher.go:174` does NOT enqueue anything —
only the terminal call at `:183` does).

**4. `wave_dispatcher.go`'s `dispatchStep`:**

```go
func (d *waveDispatcher) dispatchStep(ctx context.Context, step domain.Step, se domain.StepExecution) bool {
	se.MarkRunning()
	if err := d.stepExecutions.UpdateStepExecution(ctx, se, domain.OutboxEvent{}); err != nil {
		slog.ErrorContext(ctx, "workflow: marking step execution running failed", slog.String("step_execution_id", se.ID), slog.Any("error", err))
	}

	result, err := d.runStep(ctx, step, &se)

	subject := "orca.workflow.step.completed"
	if se.Status == domain.StepExecutionStatusFailed {
		subject = "orca.workflow.step.failed"
	}
	payload, merr := json.Marshal(stepEventPayload{
		ExecutionID: se.ExecutionID, StepID: se.StepID, StepType: string(step.Type),
		Status: string(se.Status), OriginTaskID: d.originTaskID(se.ExecutionID),
	})
	var event domain.OutboxEvent
	if merr == nil {
		event = domain.OutboxEvent{ID: uuid.NewString(), Subject: subject, OccurredAt: time.Now().UTC(), PayloadJSON: payload}
	}
	if uerr := d.stepExecutions.UpdateStepExecution(ctx, se, event); uerr != nil {
		slog.ErrorContext(ctx, "workflow: persisting terminal step execution failed", slog.String("step_execution_id", se.ID), slog.Any("error", uerr))
	}

	if err != nil {
		return false
	}
	return result.Status == domain.ResultStatusCompleted
}
```

`d.originTaskID(executionID)` is a new small helper — `dispatchStep`
currently has no execution-level context beyond `se.ExecutionID`
(confirmed: `waveDispatcher`'s fields are `stepExecutions`, `registry`,
`concurrency` only, `wave_dispatcher.go:36-40`; it has no
`ExecutionRepository` today). Add an `executions ExecutionRepository`
field to `waveDispatcher` (widen `newWaveDispatcher`'s constructor,
`:42-47`) so `dispatchStep` can look up `exec.OriginTaskID` — a single
extra `GetExecution` call per step is an acceptable cost here since
`workflow-service`'s existing wave-dispatch loop already does comparable
per-step DB round trips (`CreateStepExecution`/`UpdateStepExecution`).
Alternatively, thread `originTaskID` down from `dispatchWave`/
`dispatchWaves` as a plain parameter (both already receive `executionID`;
adding one more string avoids the extra DB call) — prefer this simpler
option if it doesn't conflict with TASK-FT-002-05's changes to the same
call chain; confirm no signature collision before choosing.

**5. `internal/adapter/postgres/repository.go`** — widen
`UpdateStepExecution` (`:308-321`, currently a single `Exec`, no
transaction) to wrap both writes in one transaction:

```go
func (r *Repository) UpdateStepExecution(ctx context.Context, se domain.StepExecution, event domain.OutboxEvent) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx, `
		UPDATE workflow.step_executions
		SET status = $1, output = $2::jsonb, error_message = $3, updated_at = now()
		WHERE id = $4
	`, string(se.Status), nullableString(se.OutputJSON), nullableString(se.Error), se.ID)
	if err != nil {
		return fmt.Errorf("postgres: update step execution: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: update step execution: no row for id %s", se.ID)
	}
	if event.ID != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO workflow.outbox_events (id, tenant_id, subject, occurred_at, version, payload)
			VALUES ($1, $2, $3, $4, 1, $5::jsonb)
		`, event.ID, tenantIDFromContext /* resolve the same way this method's caller does today */, event.Subject, event.OccurredAt, event.PayloadJSON); err != nil {
			return fmt.Errorf("postgres: insert outbox event: %w", err)
		}
	}
	return tx.Commit(ctx)
}
```

Confirm how `UpdateStepExecution` resolves `tenant_id` today — the real
method's current SQL (`repository.go:308-321`) does **not** take a
`tenantID` parameter at all (it updates by `se.ID` alone, relying on RLS
via the connection's session `app.tenant_id` setting rather than an
explicit WHERE clause). This task's outbox INSERT needs a real
`tenant_id` value for the new row — resolve it via
`current_setting('app.tenant_id', true)::uuid` in the same INSERT (same
mechanism the RLS policies elsewhere in this schema already rely on)
rather than threading a new `tenantID` parameter through every call site,
unless that turns out not to be available in this method's connection
context — check before assuming either approach compiles and behaves
correctly.

Also implement `common/outbox.Store` on `*Repository`
(`FetchUnpublished`/`MarkPublished` against `workflow.outbox_events`).

**6. `cmd/server/main.go`** — wire the relay, same shape as
TASK-FT-003-01's `orchestration-service` wiring, stream name
`"WORKFLOW"` (matches `notification-service`'s already-wired
`{StreamName: "WORKFLOW", Subject: "orca.workflow.execution.completed"}`/
`.failed` bindings, `consumer.go:46-47` — reuse the same stream, do not
create a second one for step-level subjects).

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/workflow-service/...
go test ./services/workflow-service/internal/usecase/... -run TestWaveDispatcher -v
```

Expected: a step transitioning to `completed`/`failed` enqueues the
matching subject with `OriginTaskID` populated when the owning
execution's `OriginTaskID != ""`, and empty (not absent) otherwise; the
optimistic `MarkRunning` update never enqueues anything.
