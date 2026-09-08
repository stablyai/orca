# TASK-TASKV1-005-05: Postgres — implement `CoordinatorRunRepository` + `OrchestrationTaskRepository`/`DispatchContextRepository`/`GateRepository` extensions

**From Solution:** SOL-TASKV1-005
**Priority:** P1
**Service:** `orchestration-service` (`internal/adapter/postgres`)
**File:** `backend-go/services/orchestration-service/internal/adapter/postgres/repository.go`
**Depends on:** TASK-TASKV1-005-01 (migration columns), TASK-TASKV1-005-03 (domain `ExpandSpec`/`CoordinatorRun` fields), TASK-TASKV1-005-04 (port signatures)
**Status:** `[ ]` TODO

---

## Context

`repository.go` (585 lines, read in full) implements
`OrchestrationTaskRepository`, `DispatchContextRepository`, and
`GateRepository` today via hand-written `pgx` SQL — no
`CoordinatorRunRepository` implementation exists (there is no such port to
implement before `TASK-TASKV1-005-04`). This task adds the concrete
`*Repository` methods for every port method `TASK-TASKV1-005-04` declared,
following the exact transaction/scanning conventions already established
in this file: `Create`/`Get` (`repository.go:44-95`),
`UpdateStatusAndPromote`'s `BEGIN...COMMIT` shape (`repository.go:99-135`),
`RecordDispatchFailure`'s `SELECT ... FOR UPDATE` then write shape
(`repository.go:388-427`), and `scanTask`'s nullable-column handling
(`repository.go:220-243`).

## Changes to make

### `CoordinatorRunRepository` — new section in `repository.go`

Add after the existing `GateRepository` methods (end of file), a new
`// ---- CoordinatorRunRepository -------------------------------------` section:

```go
func (r *Repository) CreateWithTasks(ctx context.Context, tenantID string, run domain.CoordinatorRun) (domain.CoordinatorRun, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	id := run.ID
	if id == "" {
		id = uuid.NewString()
	}
	var worktreeIDArg *string
	if run.WorktreeID != "" {
		worktreeIDArg = &run.WorktreeID
	}
	var createdAt time.Time
	if err := tx.QueryRow(ctx, `
		INSERT INTO orchestration.coordinator_runs (id, tenant_id, origin_task_id, spec, status, coordinator_handle, poll_interval_ms, worktree_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING created_at
	`, id, tenantID, run.OriginTaskID, run.Spec, string(run.Status), run.CoordinatorHandle, run.PollIntervalMs, worktreeIDArg).Scan(&createdAt); err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: insert coordinator run: %w", err)
	}

	// ExpandSpec resolves each node's own tempId->real-id NOW that the
	// run's real id (id, minted above) exists — mirrors
	// domain.ExpandSpec's own doc comment: "real IDs are NOT minted here."
	tasks, err := domain.ExpandSpec(tenantID, id, run.OriginTaskID, run.Spec)
	if err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: expand spec: %w", err)
	}

	// tempID -> freshly-minted real UUID, built before any INSERT so every
	// task's Deps (still tempIDs at this point) can be resolved to real
	// ids in the SAME loop that inserts them — a torn resolve here would
	// leave a task with a dep pointing at a tempId string instead of a
	// real row, permanently stuck (never satisfied by DepsSatisfied).
	realIDs := make(map[string]string, len(tasks))
	var nodes []domain.SpecNode
	if err := json.Unmarshal(run.Spec, &nodes); err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: re-parse spec for id mapping: %w", err)
	}
	for _, n := range nodes {
		realIDs[n.TempID] = uuid.NewString()
	}

	for i, t := range tasks {
		taskID := realIDs[nodes[i].TempID]
		resolvedDeps := make([]string, 0, len(t.Deps))
		for _, tempDep := range t.Deps {
			resolvedDeps = append(resolvedDeps, realIDs[tempDep])
		}
		depsJSON, err := json.Marshal(resolvedDeps)
		if err != nil {
			return domain.CoordinatorRun{}, fmt.Errorf("postgres: marshal resolved deps: %w", err)
		}
		spec := t.Spec
		if spec == nil {
			spec = json.RawMessage(`{}`)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO orchestration.orchestration_tasks (
				id, tenant_id, coordinator_run_id, origin_task_id, task_title, spec, status, deps
			) VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,$7,$8)
		`, taskID, tenantID, id, t.OriginTaskID, t.TaskTitle, spec, string(t.Status), depsJSON); err != nil {
			return domain.CoordinatorRun{}, fmt.Errorf("postgres: insert orchestration task %q: %w", t.TaskTitle, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: commit create-with-tasks tx: %w", err)
	}

	run.ID = id
	run.CreatedAt = createdAt
	return run, nil
}

func (r *Repository) Get(ctx context.Context, tenantID, id string) (domain.CoordinatorRun, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, origin_task_id, spec, status, coordinator_handle, poll_interval_ms,
		       worktree_id, result, error_message, created_at, completed_at
		FROM orchestration.coordinator_runs
		WHERE id = $1 AND tenant_id = $2
	`, id, tenantID)
	run, err := scanCoordinatorRun(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.CoordinatorRun{}, usecase.ErrRunNotFound
	}
	if err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: query coordinator run: %w", err)
	}
	return run, nil
}

func (r *Repository) Complete(ctx context.Context, tenantID, id string, result json.RawMessage) (domain.CoordinatorRun, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE orchestration.coordinator_runs
		SET status = 'completed', result = $1, completed_at = now()
		WHERE id = $2 AND tenant_id = $3 AND status = 'running'
		RETURNING id, tenant_id, origin_task_id, spec, status, coordinator_handle, poll_interval_ms,
		          worktree_id, result, error_message, created_at, completed_at
	`, result, id, tenantID)
	run, err := scanCoordinatorRun(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.CoordinatorRun{}, usecase.ErrRunNotFound
	}
	if err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: complete coordinator run: %w", err)
	}
	return run, nil
}

func (r *Repository) Fail(ctx context.Context, tenantID, id, errMsg string) (domain.CoordinatorRun, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE orchestration.coordinator_runs
		SET status = 'failed', error_message = $1, completed_at = now()
		WHERE id = $2 AND tenant_id = $3 AND status IN ('running', 'idle')
		RETURNING id, tenant_id, origin_task_id, spec, status, coordinator_handle, poll_interval_ms,
		          worktree_id, result, error_message, created_at, completed_at
	`, errMsg, id, tenantID)
	run, err := scanCoordinatorRun(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.CoordinatorRun{}, usecase.ErrRunNotFound
	}
	if err != nil {
		return domain.CoordinatorRun{}, fmt.Errorf("postgres: fail coordinator run: %w", err)
	}
	return run, nil
}

func (r *Repository) ListRunning(ctx context.Context) ([]domain.CoordinatorRun, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, origin_task_id, spec, status, coordinator_handle, poll_interval_ms,
		       worktree_id, result, error_message, created_at, completed_at
		FROM orchestration.coordinator_runs
		WHERE status = 'running'
	`)
	if err != nil {
		return nil, fmt.Errorf("postgres: query running coordinator runs: %w", err)
	}
	defer rows.Close()

	out := []domain.CoordinatorRun{}
	for rows.Next() {
		run, err := scanCoordinatorRun(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan running coordinator run: %w", err)
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate running coordinator runs: %w", err)
	}
	return out, nil
}

func (r *Repository) MarkReported(ctx context.Context, tenantID, id string) error {
	if _, err := r.pool.Exec(ctx, `
		UPDATE orchestration.coordinator_runs SET reported_at = now()
		WHERE id = $1 AND tenant_id = $2
	`, id, tenantID); err != nil {
		return fmt.Errorf("postgres: mark coordinator run reported: %w", err)
	}
	return nil
}

func (r *Repository) ListUnreportedTerminal(ctx context.Context) ([]domain.CoordinatorRun, error) {
	// Reuses idx_coordinator_runs_unreported (TASK-TASKV1-005-01) — this
	// WHERE clause matches that partial index verbatim.
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, origin_task_id, spec, status, coordinator_handle, poll_interval_ms,
		       worktree_id, result, error_message, created_at, completed_at
		FROM orchestration.coordinator_runs
		WHERE status IN ('completed', 'failed') AND reported_at IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("postgres: query unreported terminal runs: %w", err)
	}
	defer rows.Close()

	out := []domain.CoordinatorRun{}
	for rows.Next() {
		run, err := scanCoordinatorRun(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan unreported terminal run: %w", err)
		}
		out = append(out, run)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate unreported terminal runs: %w", err)
	}
	return out, nil
}

// scanCoordinatorRun mirrors scanTask's nullable-column-handling
// convention (repository.go:220-243), shared by Get/Complete/Fail/ListRunning
// so the mapping can't drift between them.
func scanCoordinatorRun(row pgx.Row) (domain.CoordinatorRun, error) {
	var run domain.CoordinatorRun
	var status string
	var specJSON, resultJSON []byte
	var worktreeID, errorMessage *string
	var completedAt *time.Time
	if err := row.Scan(
		&run.ID, &run.TenantID, &run.OriginTaskID, &specJSON, &status, &run.CoordinatorHandle, &run.PollIntervalMs,
		&worktreeID, &resultJSON, &errorMessage, &run.CreatedAt, &completedAt,
	); err != nil {
		return domain.CoordinatorRun{}, err
	}
	run.Status = domain.RunStatus(status)
	run.Spec = specJSON
	run.Result = resultJSON
	if worktreeID != nil {
		run.WorktreeID = *worktreeID
	}
	if errorMessage != nil {
		run.ErrorMessage = *errorMessage
	}
	if completedAt != nil {
		run.CompletedAt = *completedAt
	}
	return run, nil
}
```

### `OrchestrationTaskRepository` extensions

Add after the existing `promoteReadySiblings`/`scanTask` functions:

```go
func (r *Repository) ListReadyUnclaimed(ctx context.Context) ([]domain.OrchestrationTask, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT ot.id, ot.tenant_id, ot.coordinator_run_id, COALESCE(ot.parent_id::text, ''), COALESCE(ot.origin_task_id, ''),
		       ot.task_title, ot.spec, ot.status, ot.deps, ot.result, ot.created_at, ot.completed_at
		FROM orchestration.orchestration_tasks ot
		WHERE ot.status = 'ready'
		  AND NOT EXISTS (
		    SELECT 1 FROM orchestration.dispatch_contexts dc WHERE dc.orchestration_task_id = ot.id
		  )
	`)
	if err != nil {
		return nil, fmt.Errorf("postgres: query ready unclaimed tasks: %w", err)
	}
	defer rows.Close()

	out := []domain.OrchestrationTask{}
	for rows.Next() {
		task, err := scanTask(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan ready unclaimed task: %w", err)
		}
		out = append(out, task)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate ready unclaimed tasks: %w", err)
	}
	return out, nil
}

// ClaimReady is the CAS the tick loop relies on for "exactly one instance
// dispatches this task" — a plain UPDATE...WHERE status='ready' RETURNING,
// no explicit transaction needed since a single-row UPDATE is already
// atomic in Postgres.
func (r *Repository) ClaimReady(ctx context.Context, tenantID, taskID string) (domain.OrchestrationTask, bool, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE orchestration.orchestration_tasks
		SET status = 'dispatched'
		WHERE id = $1 AND tenant_id = $2 AND status = 'ready'
		RETURNING id, tenant_id, coordinator_run_id, COALESCE(parent_id::text, ''), COALESCE(origin_task_id, ''),
		          task_title, spec, status, deps, result, created_at, completed_at
	`, taskID, tenantID)
	task, err := scanTask(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.OrchestrationTask{}, false, nil // lost the race — not an error
	}
	if err != nil {
		return domain.OrchestrationTask{}, false, fmt.Errorf("postgres: claim ready task: %w", err)
	}
	return task, true, nil
}

func (r *Repository) CountNonTerminalByRun(ctx context.Context, tenantID, coordinatorRunID string) (int, error) {
	var count int
	if err := r.pool.QueryRow(ctx, `
		SELECT count(*) FROM orchestration.orchestration_tasks
		WHERE coordinator_run_id = $1 AND tenant_id = $2
		  AND status NOT IN ('completed', 'failed')
	`, coordinatorRunID, tenantID).Scan(&count); err != nil {
		return 0, fmt.Errorf("postgres: count non-terminal tasks: %w", err)
	}
	return count, nil
}
```

### `DispatchContextRepository.RecordHeartbeat`

Add after `RecordDispatchFailure`:

```go
func (r *Repository) RecordHeartbeat(ctx context.Context, tenantID, dispatchContextID string) (domain.DispatchContext, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE orchestration.dispatch_contexts
		SET last_heartbeat_at = now()
		WHERE id = $1 AND tenant_id = $2
		RETURNING id, tenant_id, worktree_id, orchestration_task_id, handle, coordinator_run_id, status, created_at, last_heartbeat_at
	`, dispatchContextID, tenantID)

	var dc domain.DispatchContext
	var status string
	var worktreeID, orchestrationTaskID *string
	if err := row.Scan(&dc.ID, &dc.TenantID, &worktreeID, &orchestrationTaskID, &dc.Handle, &dc.CoordinatorRunID, &status, &dc.CreatedAt, &dc.LastHeartbeatAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.DispatchContext{}, usecase.ErrDispatchContextNotFound
		}
		return domain.DispatchContext{}, fmt.Errorf("postgres: record heartbeat: %w", err)
	}
	if worktreeID != nil {
		dc.WorktreeID = *worktreeID
	}
	if orchestrationTaskID != nil {
		dc.OrchestrationTaskID = *orchestrationTaskID
	}
	dc.Status = domain.DispatchStatus(status)
	return dc, nil
}
```

### `GateRepository.ListPending`

Add after `ResolveGate`:

```go
func (r *Repository) ListPending(ctx context.Context, tenantID string) ([]domain.DecisionGate, error) {
	// Reuses idx_gates_pending (0001_init.up.sql:91,
	// WHERE status = 'pending') — this query's WHERE clause matches that
	// partial index verbatim so the planner can actually use it.
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, orchestration_task_id, dispatch_context_id, question, options, status, resolution, created_at, resolved_at
		FROM orchestration.decision_gates
		WHERE tenant_id = $1 AND status = 'pending'
		ORDER BY created_at ASC
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query pending gates: %w", err)
	}
	defer rows.Close()

	out := []domain.DecisionGate{}
	for rows.Next() {
		var g domain.DecisionGate
		var status string
		var dispatchContextID, resolution *string
		var optionsJSON []byte
		var resolvedAt *time.Time
		if err := rows.Scan(&g.ID, &g.TenantID, &g.OrchestrationTaskID, &dispatchContextID, &g.Question, &optionsJSON, &status, &resolution, &g.CreatedAt, &resolvedAt); err != nil {
			return nil, fmt.Errorf("postgres: scan pending gate: %w", err)
		}
		g.Status = domain.GateStatus(status)
		if dispatchContextID != nil {
			g.DispatchContextID = *dispatchContextID
		}
		if resolution != nil {
			g.Resolution = *resolution
		}
		if resolvedAt != nil {
			g.ResolvedAt = *resolvedAt
		}
		if len(optionsJSON) > 0 {
			if err := json.Unmarshal(optionsJSON, &g.Options); err != nil {
				return nil, fmt.Errorf("postgres: unmarshal gate options: %w", err)
			}
		}
		out = append(out, g)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate pending gates: %w", err)
	}
	return out, nil
}
```

## Verify

```bash
cd /opt/repos/orca/backend-go
go build ./services/orchestration-service/...
go test ./services/orchestration-service/internal/adapter/postgres/... -run 'TestRepository_CreateWithTasks|TestRepository_ClaimReady|TestRepository_ListPending|TestRepository_CountNonTerminalByRun|TestRepository_RecordHeartbeat' -v
```

Expected (uses this package's existing real-Postgres-test-container
convention, not fakes, per this file's own package doc comment): `go build`
succeeds — `*Repository` now satisfies the widened
`OrchestrationTaskRepository`/`DispatchContextRepository`/`GateRepository`
interfaces plus the new `CoordinatorRunRepository`. New tests:
`CreateWithTasks` round-trips a multi-node `ExpandSpec` output with dep
resolution intact (a child's `Deps` correctly resolve from `tempId` strings
to the parent's real minted UUID, not left as raw tempId strings);
`ClaimReady` under concurrent goroutines claiming the same row — exactly
one succeeds; `ListPending` returns only `pending` rows, respects the
partial index's own filter; `CountNonTerminalByRun` excludes
completed/failed and counts pending/ready/dispatched/blocked;
`RecordHeartbeat` updates `last_heartbeat_at` and returns
`ErrDispatchContextNotFound` for an unknown id; `ListUnreportedTerminal`
returns only `completed`/`failed` runs with `reported_at IS NULL`, and
`MarkReported` removes a run from that list on the next call.
