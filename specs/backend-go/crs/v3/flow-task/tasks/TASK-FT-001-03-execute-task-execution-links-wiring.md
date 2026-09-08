# TASK-FT-001-03: `ExecutionLinkRepository` port/adapter + `ExecuteTask` writes one `execution_links` row per call

**From Solution:** BE-SOL-001
**Priority:** P0
**Service:** `task-service`
**File:** `backend-go/services/task-service/internal/usecase/ports.go` (new `ExecutionLinkRepository`), `backend-go/services/task-service/internal/adapter/postgres/execution_links.go` (new), `backend-go/services/task-service/internal/usecase/execute_task.go` (`Execute` wiring), `backend-go/services/task-service/cmd/server/main.go` (constructor wiring)
**Depends on:** TASK-FT-001-01 (`task.execution_links` table), TASK-FT-001-02 (`selectEngine`/`ExecutionEngine`)
**Status:** `[ ]` TODO

---

## Context

Per CR-FLOW-TASK-001's acceptance criteria, every `Execute` call — **including
the synchronous Engine 1 (direct-agent) path** — must record one
`execution_links` row, not just the async Engine 2/3 dispatches. This is
needed so CR-FLOW-TASK-003's Activity Feed (BE-SOL-003) has a history row
for every execution, not just the async ones.

`ExecuteTask`'s current, real constructor is `NewExecuteTask(repo
TaskRepository, edges EdgeRepository, simple SimpleExecutor, complex
ComplexExecutor) *ExecuteTask`
(`internal/usecase/execute_task.go:44-46`), wired in
`cmd/server/main.go:121` as `usecase.NewExecuteTask(repo, repo,
simpleExecutor, complexExecutor)`. This task adds a fifth constructor
argument, `links ExecutionLinkRepository`.

## Changes to make

**1. `internal/usecase/ports.go`** — new port, same file/package as
`SimpleExecutor`/`ComplexExecutor` (`ports.go:109-131`):

```go
// ExecutionLinkRepository is the persistence port for
// task.execution_links (BE-SOL-001/CR-FLOW-TASK-001) — one row per
// ExecuteTask dispatch, across all three engines, giving CR-FLOW-TASK-003's
// Activity Feed a history row even for the synchronous Engine 1 path.
type ExecutionLinkRepository interface {
	// Create inserts a new execution_links row for tenantID/taskID/engine.
	// externalRefID may be empty at creation time (Engine 1 has none; the
	// async engines' ref is only known after dispatch succeeds — see
	// SetExternalRef below).
	Create(ctx context.Context, tenantID, taskID string, engine domain.ExecutionEngine, externalRefID string) (domain.ExecutionLink, error)
	// SetExternalRef backfills external_ref_id once an async dispatch
	// (Engine 2/3) returns its coordinator_run_id / workflow execution id —
	// called after Create, before Complete.
	SetExternalRef(ctx context.Context, tenantID, linkID, externalRefID string) error
	// Complete marks a link's status_mirror/completed_at terminal —
	// "completed" or "failed". For Engine 1 this reflects the synchronous
	// dispatch result immediately; for Engine 2/3, BE-SOL-003's consumer
	// (TASK-FT-003-05) later updates status_mirror again as real terminal
	// events arrive — Complete here only marks task-service's own initial
	// bookkeeping, it does not have to be the last word for async engines.
	Complete(ctx context.Context, tenantID, linkID, statusMirror string) error
}
```

Add `domain.ExecutionLink` (a plain read model, `internal/domain/execution_link.go`,
new):

```go
package domain

import "time"

// ExecutionLink is one task.execution_links row — see TASK-FT-001-01's
// migration for the full column set this mirrors.
type ExecutionLink struct {
	ID            string
	TenantID      string
	TaskID        string
	Engine        ExecutionEngine
	ExternalRefID string
	StatusMirror  string
	StartedAt     time.Time
	CompletedAt   *time.Time
}
```

**2. New `internal/adapter/postgres/execution_links.go`** — plain
hand-written SQL against `task.execution_links`, same convention as this
package's other repository files (`edges.go`, `grants.go`):

```go
package postgres

import (
	"context"
	"fmt"

	"github.com/stablyai/orca-go/services/task-service/internal/domain"
)

func (r *Repository) Create(ctx context.Context, tenantID, taskID string, engine domain.ExecutionEngine, externalRefID string) (domain.ExecutionLink, error) {
	var link domain.ExecutionLink
	err := r.pool.QueryRow(ctx, `
		INSERT INTO task.execution_links (tenant_id, task_id, engine, external_ref_id)
		VALUES ($1, $2, $3, $4)
		RETURNING id, tenant_id, task_id, engine, external_ref_id, status_mirror, started_at, completed_at
	`, tenantID, taskID, string(engine), externalRefID).Scan(
		&link.ID, &link.TenantID, &link.TaskID, (*string)(&link.Engine), &link.ExternalRefID, &link.StatusMirror, &link.StartedAt, &link.CompletedAt,
	)
	if err != nil {
		return domain.ExecutionLink{}, fmt.Errorf("postgres: insert execution link: %w", err)
	}
	return link, nil
}

func (r *Repository) SetExternalRef(ctx context.Context, tenantID, linkID, externalRefID string) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE task.execution_links SET external_ref_id = $1 WHERE id = $2 AND tenant_id = $3
	`, externalRefID, linkID, tenantID)
	if err != nil {
		return fmt.Errorf("postgres: set execution link external ref: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: set execution link external ref: no row for id %s", linkID)
	}
	return nil
}

func (r *Repository) Complete(ctx context.Context, tenantID, linkID, statusMirror string) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE task.execution_links SET status_mirror = $1, completed_at = now() WHERE id = $2 AND tenant_id = $3
	`, statusMirror, linkID, tenantID)
	if err != nil {
		return fmt.Errorf("postgres: complete execution link: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: complete execution link: no row for id %s", linkID)
	}
	return nil
}
```

Confirm the exact `*Repository` receiver/package name and pool field
(`r.pool`) against the real `internal/adapter/postgres/repository.go`
before writing this file — this task's snippet assumes the same shape
`edges.go`/`grants.go` already use in this package; do not introduce a
second `Repository` type.

**3. `internal/usecase/execute_task.go`** — `Execute` wraps dispatch with
one `execution_links` write before and after, for all three engine
branches (including the synchronous Engine 1 path per the CR's acceptance
criteria):

```go
type ExecuteTask struct {
	repo    TaskRepository
	edges   EdgeRepository
	simple  SimpleExecutor
	complex ComplexExecutor
	links   ExecutionLinkRepository
}

func NewExecuteTask(repo TaskRepository, edges EdgeRepository, simple SimpleExecutor, complex ComplexExecutor, links ExecutionLinkRepository) *ExecuteTask {
	return &ExecuteTask{repo: repo, edges: edges, simple: simple, complex: complex, links: links}
}
```

```go
func (uc *ExecuteTask) Execute(ctx context.Context, in ExecuteTaskInput) (string, error) {
	// ... existing tenant/task-id validation and UpdateStatus(StatusInProgress) unchanged ...

	task, err := uc.repo.Get(ctx, tenantID, in.TaskID)
	if err != nil {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_LOAD_FAILED", "failed to load task", err)
	}
	engine, err := uc.selectEngine(ctx, tenantID, task)
	if err != nil {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_EDGE_LOOKUP_FAILED", "failed to determine execution engine", err)
	}

	link, linkErr := uc.links.Create(ctx, tenantID, in.TaskID, engine, "")
	if linkErr != nil {
		// A failed link write must not silently proceed with an
		// unaccounted-for dispatch — CR-FLOW-TASK-001's acceptance
		// criteria require a row for every Execute call, so this is a
		// real, fail-closed error, not best-effort logging.
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_LINK_CREATE_FAILED", "failed to record execution link", linkErr)
	}

	var ref string
	switch engine {
	case domain.EngineOrchestration:
		ref, err = uc.complex.Execute(ctx, tenantID, in.TaskID, in.RequestID)
	case domain.EngineWorkflow:
		// TODO(BE-SOL-002/TASK-FT-002-03): dispatch via WorkflowExecutor
		// once it exists — placeholder keeps this branch on the existing
		// ComplexExecutor path so behavior for the two engines that exist
		// today is unchanged.
		ref, err = uc.complex.Execute(ctx, tenantID, in.TaskID, in.RequestID)
	default: // domain.EngineDirectAgent
		ref, err = uc.simple.Execute(ctx, tenantID, in.TaskID, in.RequestID)
	}

	status := "completed"
	if err != nil {
		status = "failed"
	} else if ref != "" {
		_ = uc.links.SetExternalRef(ctx, tenantID, link.ID, ref) // best-effort: a failed backfill doesn't invalidate a dispatch that already succeeded
	}
	_ = uc.links.Complete(ctx, tenantID, link.ID, status) // best-effort, same posture as this codebase's other non-critical bookkeeping writes (see execute.go's runToCompletion for the precedent)

	if err != nil {
		return "", apperrors.New(apperrors.KindInternal, "TASK_EXECUTE_FAILED", "execution dispatch failed", err)
	}
	return ref, nil
}
```

This task does **not** change `SimpleExecutor`/`ComplexExecutor`'s dispatch
calls themselves — matching CR-FLOW-TASK-001's explicit risk note that the
status-revert-on-failure rework and real `ComplexExecutor` body stay
SOL-TG-04's scope.

**4. `cmd/server/main.go`** — update the `NewExecuteTask` call site
(`main.go:121`) to pass `repo` as the fifth argument (the same
`*postgres.Repository` already implements `TaskRepository`/
`EdgeRepository`, and now `ExecutionLinkRepository` too, per this task's
step 2):

```go
executeTaskUC := usecase.NewExecuteTask(repo, repo, simpleExecutor, complexExecutor, repo)
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/task-service/...
go test ./services/task-service/internal/usecase/... -run TestExecuteTask -v
go test ./services/task-service/internal/adapter/postgres/... -run TestRepository -v
```

Expected: clean build; `TestExecuteTask_*` (updated in TASK-FT-001-04)
pass against a fake `ExecutionLinkRepository`; the real postgres adapter's
`Create`/`SetExternalRef`/`Complete` round-trip correctly against a live
`task.execution_links` table (testcontainers).
