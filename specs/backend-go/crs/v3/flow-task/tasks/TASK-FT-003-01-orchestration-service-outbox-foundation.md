# TASK-FT-003-01: `orchestration-service` outbox foundation — migration, domain type, repository-owned enqueue (corrected port shape)

**From Solution:** BE-SOL-003
**Priority:** P0
**Service:** `orchestration-service`
**File:** `backend-go/services/orchestration-service/migrations/0004_outbox_events.up.sql` (new), `backend-go/services/orchestration-service/migrations/0004_outbox_events.down.sql` (new), `backend-go/services/orchestration-service/internal/domain/outbox_event.go` (new), `backend-go/services/orchestration-service/internal/usecase/ports.go` (repository interfaces widened, NOT a standalone `OutboxStore`), `backend-go/services/orchestration-service/internal/adapter/postgres/repository.go` (existing methods widened to also enqueue), `backend-go/services/orchestration-service/internal/usecase/create_dispatch_context.go`, `update_task_status_and_promote.go` (call-site signature changes), `backend-go/services/orchestration-service/cmd/server/main.go` (wire `outbox.Relay`)
**Depends on:** None (first BE-SOL-003 task)
**Status:** `[ ]` TODO

---

## Context

**Grounding correction versus BE-SOL-003's own sketch** — this is the
single most important thing to read before writing this task, since the
solution's `OutboxStore.Enqueue(ctx, tx pgx.Tx, ...)` port sketch does not
match how transactions actually flow in this codebase and will not
compile as designed.

Verified by reading `orchestration-service`'s real usecase layer directly:
`UpdateTaskStatusAndPromote.Execute`, `CreateGate.Execute`,
`ResolveGate.Execute`, and `FailDispatch.Execute` each call a single
repository method (`uc.repo.UpdateStatusAndPromote(...)`,
`uc.repo.CreateGate(...)`, etc.) and **never see a `pgx.Tx` themselves** —
the transaction (where one exists) is opened and committed entirely
inside `internal/adapter/postgres/repository.go`'s own method bodies
(confirmed: `UpdateStatusAndPromote` at `repository.go:99-145`,
`CreateGate` at `:447-515`, `ResolveGate` at `:516-577`, and
`RecordDispatchFailure` at `:389-432` each open their own `tx, err :=
r.pool.Begin(ctx)` / `defer tx.Rollback` / `tx.Commit` internally;
`CreateDispatchContext` at `:251-295` does a single `Exec`/`QueryRow`,
no explicit transaction at all today). A usecase-level `Enqueue(ctx, tx,
...)` port is unreachable from where BE-SOL-003 proposes calling it.

**The actual, working precedent in this codebase** is `usage-service`'s
`RecordUsageSession`/`Repository.SaveSession`: the **usecase** builds a
`domain.OutboxEvent` value (no `pgx.Tx` involved) and passes it as an
extra *parameter* into the same repository method that already writes
the domain row — `SaveSession(ctx, session, event) error`
(`usage-service/internal/usecase/ports.go:18-26`,
`record_usage_session.go:78-97`) — and the repository implementation
inserts both rows in the SAME transaction it already manages internally
(`usage-service/internal/adapter/postgres/repository.go:34-93`). This
task follows that pattern, not BE-SOL-003's `Enqueue(ctx, tx, ...)`
sketch.

## Changes to make

**1. Migration** (verified next-free number: `0001`-`0003` exist today,
confirmed via `ls
backend-go/services/orchestration-service/migrations/`):

`0004_outbox_events.up.sql` (same shape as `usage.outbox_events`,
`usage-service/migrations/0002_outbox.up.sql` — the working precedent):

```sql
CREATE TABLE orchestration.outbox_events (
    id            UUID PRIMARY KEY,
    tenant_id     UUID NOT NULL,
    subject       TEXT NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL,
    version       INT NOT NULL,
    payload       JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ
);
CREATE INDEX idx_orchestration_outbox_events_unpublished
    ON orchestration.outbox_events (created_at)
    WHERE published_at IS NULL;
```

`0004_outbox_events.down.sql`:

```sql
DROP TABLE IF EXISTS orchestration.outbox_events;
```

**2. `internal/domain/outbox_event.go`** (new) — same shape as
`usage-service/internal/domain/outbox.go`:

```go
package domain

import "time"

// OutboxEvent is a pre-built event a usecase asks its repository to
// durably enqueue in the SAME transaction as the domain write it
// accompanies — see TASK-FT-003-01's Context for why this follows
// usage-service's SaveSession(ctx, session, event) pattern rather than
// exposing a pgx.Tx to the usecase layer.
type OutboxEvent struct {
	ID          string
	Subject     string
	OccurredAt  time.Time
	PayloadJSON []byte
}
```

**3. Widen repository method signatures** — `ports.go`'s
`OrchestrationTaskRepository.UpdateStatusAndPromote` and
`DispatchContextRepository.CreateDispatchContext` each gain an
`event domain.OutboxEvent` parameter (pass a zero-value `OutboxEvent{}`
when the usecase has nothing to enqueue, though in practice every call
site below always builds a real one):

```go
// ports.go — UpdateStatusAndPromote's signature, widened
UpdateStatusAndPromote(ctx context.Context, tenantID, taskID string, newStatus domain.TaskStatus, event domain.OutboxEvent) (domain.OrchestrationTask, []string, error)

// CreateDispatchContext's signature, widened
CreateDispatchContext(ctx context.Context, tenantID, userID, worktreeID, handle, coordinatorRunID, orchestrationTaskID string, event domain.OutboxEvent) (domain.DispatchContext, error)
```

`GateRepository.CreateGate`/`ResolveGate` are handled by TASK-FT-003-02
instead (they need the *new* `orchestration.messages` write too, not just
an outbox row — kept as one combined change there rather than widening
their signatures twice).

**4. `internal/adapter/postgres/repository.go`** — each widened method
inserts into `orchestration.outbox_events` using the SAME transaction it
already opens (or, for `CreateDispatchContext`, a transaction this task
adds since none exists today):

```go
// UpdateStatusAndPromote — inside the existing tx (repository.go:99-145),
// right before tx.Commit:
if event.ID != "" {
	if _, err := tx.Exec(ctx, `
		INSERT INTO orchestration.outbox_events (id, tenant_id, subject, occurred_at, version, payload)
		VALUES ($1, $2, $3, $4, 1, $5::jsonb)
	`, event.ID, tenantID, event.Subject, event.OccurredAt, event.PayloadJSON); err != nil {
		return domain.OrchestrationTask{}, nil, fmt.Errorf("postgres: insert outbox event: %w", err)
	}
}
```

```go
// CreateDispatchContext — this method has NO transaction today (a single
// INSERT); this task wraps it in one so the outbox row commits atomically
// with the dispatch-context row:
func (r *Repository) CreateDispatchContext(ctx context.Context, tenantID, userID, worktreeID, handle, coordinatorRunID, orchestrationTaskID string, event domain.OutboxEvent) (domain.DispatchContext, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.DispatchContext{}, fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// ... the existing single INSERT/QueryRow, now via tx instead of r.pool ...

	if event.ID != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO orchestration.outbox_events (id, tenant_id, subject, occurred_at, version, payload)
			VALUES ($1, $2, $3, $4, 1, $5::jsonb)
		`, event.ID, tenantID, event.Subject, event.OccurredAt, event.PayloadJSON); err != nil {
			return domain.DispatchContext{}, fmt.Errorf("postgres: insert outbox event: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.DispatchContext{}, fmt.Errorf("postgres: commit tx: %w", err)
	}
	return result, nil
}
```

Also implement `common/outbox.Store` on `*Repository` (identical shape to
`usage-service/internal/adapter/postgres/repository.go:99-137`'s
`FetchUnpublished`/`MarkPublished`, targeting
`orchestration.outbox_events` instead of `usage.outbox_events`).

**5. Usecase call sites** — `update_task_status_and_promote.go` and
`create_dispatch_context.go` each build the `domain.OutboxEvent` before
calling their (now-widened) repository method:

```go
// update_task_status_and_promote.go, inside Execute, before uc.repo.UpdateStatusAndPromote:
payload, err := json.Marshal(taskStatusChangedPayload{
	OrchestrationTaskID: in.OrchestrationTaskID, NewStatus: string(newStatus),
})
event := domain.OutboxEvent{} // stays zero-value (skips the enqueue) if payload marshaling fails — see comment below
if err == nil {
	event = domain.OutboxEvent{ID: uuid.NewString(), Subject: "orca.orchestration.task.statuschanged", OccurredAt: time.Now().UTC(), PayloadJSON: payload}
} else {
	// Marshal failure degrades to "persist the status change, skip the
	// event" — same best-effort posture workflow-service's
	// runToCompletion already uses for its own terminal-event marshal
	// failure (see TASK-PW-04-06's precedent), not a fatal error for the
	// status transition itself.
}
task, promoted, err := uc.repo.UpdateStatusAndPromote(ctx, tenantID, in.OrchestrationTaskID, newStatus, event)
```

Similarly for `create_dispatch_context.go`, subject
`orca.orchestration.task.dispatched`, payload carrying at minimum
`orchestration_task_id`/`coordinator_run_id`/`handle`.

**6. `cmd/server/main.go`** — wire the relay, identical shape to
`usage-service/cmd/server/main.go:100-121`:

```go
var relay *outbox.Relay
pub, _, closeBus, err := eventbus.Connect(ctx, cfg.NATSURL)
if err != nil {
	logger.WarnContext(ctx, "eventbus unavailable, outbox events will queue until a future restart", slog.Any("error", err))
} else {
	defer func() { _ = closeBus() }()
	if err := pub.EnsureStream(ctx, "ORCHESTRATION", []string{"orca.orchestration.>"}); err != nil {
		logger.WarnContext(ctx, "failed to ensure ORCHESTRATION stream", slog.Any("error", err))
	} else {
		relay = outbox.NewRelay(repo, pub, outbox.DefaultConfig, logger)
	}
}
if relay != nil {
	go relay.Run(ctx)
}
```

Stream name `"ORCHESTRATION"` matches `notification-service`'s
ALREADY-WIRED `SubjectBinding{StreamName: "ORCHESTRATION", Subject:
"orca.orchestration.decision_gate.opened"}`
(`notification-service/internal/adapter/eventbus/consumer.go:50`,
confirmed by reading the file directly) — do not rename it. Add `NATSURL
string` to `orchestration-service`'s config if not already present
(confirmed absent today: this service's config currently has no NATS
field, since it has no eventbus package at all).

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go test ./services/orchestration-service/internal/usecase/... -run "TestUpdateTaskStatusAndPromote|TestCreateDispatchContext" -v
go test ./services/orchestration-service/internal/adapter/postgres/... -run TestRepository -v
```

Expected: clean build; `UpdateTaskStatusAndPromote`/`CreateDispatchContext`
each enqueue exactly one outbox row in the same fake/real transaction as
their existing domain write; a marshal failure degrades to "write the
domain row, skip the event" without failing the whole call.
