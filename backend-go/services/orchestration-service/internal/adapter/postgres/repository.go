// Package postgres implements orchestration-service's repository ports
// (defined in internal/usecase) against this service's own PostgreSQL
// database — see specs/backend-go/architecture/05-data-architecture.md's
// database-per-service rule: this is the ONLY package in
// orchestration-service that knows SQL exists.
//
// UpdateStatusAndPromote, Create (gate) and Resolve (gate) are each a
// single Postgres transaction — the hard NFR from
// specs/backend-go/services/orchestration-service.md §8: a torn read
// between marking a task complete and re-scanning its dependents can
// double-dispatch a task or leave a ready task stuck pending.
package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/orchestration-service/internal/domain"
	"github.com/stablyai/orca-go/services/orchestration-service/internal/usecase"
)

// Repository implements usecase.OrchestrationTaskRepository,
// usecase.DispatchContextRepository, and usecase.GateRepository against
// Postgres via pgx — hand-written SQL (see architecture/04-tech-stack.md:
// sqlc codegen is the eventual target; this scaffold hand-writes the
// equivalent queries directly, matching usage-service's pilot precedent).
type Repository struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

// ---- OrchestrationTaskRepository ---------------------------------------

func (r *Repository) Create(ctx context.Context, task domain.OrchestrationTask) (domain.OrchestrationTask, error) {
	id := task.ID
	if id == "" {
		id = uuid.NewString()
	}
	spec := task.Spec
	if spec == nil {
		spec = json.RawMessage(`{}`)
	}
	depsJSON, err := json.Marshal(task.Deps)
	if err != nil {
		return domain.OrchestrationTask{}, fmt.Errorf("postgres: marshal deps: %w", err)
	}

	row := r.pool.QueryRow(ctx, `
		INSERT INTO orchestration.orchestration_tasks (
			id, tenant_id, coordinator_run_id, parent_id, origin_task_id, task_title, spec, status, deps
		) VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,$7,'pending',$8)
		RETURNING created_at
	`, id, task.TenantID, task.CoordinatorRunID, task.ParentID, task.OriginTaskID, task.TaskTitle, spec, depsJSON)

	var createdAt time.Time
	if err := row.Scan(&createdAt); err != nil {
		return domain.OrchestrationTask{}, fmt.Errorf("postgres: insert orchestration task: %w", err)
	}

	task.ID = id
	task.Status = domain.TaskStatusPending
	task.Spec = spec
	task.CreatedAt = createdAt
	return task, nil
}

func (r *Repository) Get(ctx context.Context, tenantID, id string) (domain.OrchestrationTask, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, coordinator_run_id, COALESCE(parent_id::text, ''), COALESCE(origin_task_id, ''),
		       task_title, spec, status, deps, result, created_at, completed_at
		FROM orchestration.orchestration_tasks
		WHERE id = $1 AND tenant_id = $2
	`, id, tenantID)
	task, err := scanTask(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.OrchestrationTask{}, usecase.ErrTaskNotFound
	}
	if err != nil {
		return domain.OrchestrationTask{}, fmt.Errorf("postgres: query orchestration task: %w", err)
	}
	return task, nil
}

// UpdateStatusAndPromote is the atomic promote saga (§8): BEGIN, update the
// task's status, scan pending siblings in the same coordinator_run_id
// whose deps are now all completed, promote them to ready, COMMIT. All in
// one transaction — a crash or error partway through rolls back the whole
// thing rather than leaving a half-applied state.
func (r *Repository) UpdateStatusAndPromote(ctx context.Context, tenantID, taskID string, newStatus domain.TaskStatus) (domain.OrchestrationTask, []string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.OrchestrationTask{}, nil, fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var completedAt *time.Time
	if newStatus == domain.TaskStatusCompleted || newStatus == domain.TaskStatusFailed {
		now := time.Now().UTC()
		completedAt = &now
	}

	row := tx.QueryRow(ctx, `
		UPDATE orchestration.orchestration_tasks
		SET status = $1, completed_at = COALESCE($2, completed_at)
		WHERE id = $3 AND tenant_id = $4
		RETURNING id, tenant_id, coordinator_run_id, COALESCE(parent_id::text, ''), COALESCE(origin_task_id, ''),
		          task_title, spec, status, deps, result, created_at, completed_at
	`, string(newStatus), completedAt, taskID, tenantID)
	task, err := scanTask(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.OrchestrationTask{}, nil, usecase.ErrTaskNotFound
	}
	if err != nil {
		return domain.OrchestrationTask{}, nil, fmt.Errorf("postgres: update task status: %w", err)
	}

	var promotedIDs []string
	if newStatus == domain.TaskStatusCompleted {
		promotedIDs, err = promoteReadySiblings(ctx, tx, tenantID, task.CoordinatorRunID)
		if err != nil {
			return domain.OrchestrationTask{}, nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.OrchestrationTask{}, nil, fmt.Errorf("postgres: commit tx: %w", err)
	}
	return task, promotedIDs, nil
}

// promoteReadySiblings scans every pending task in coordinatorRunID,
// applies domain.OrchestrationTask.DepsSatisfied against the set of
// completed ids in that run, and flips any satisfied task to ready — the
// same pure rule internal/domain exposes, applied here inside the
// transaction so the SQL-level and unit-testable domain-level definitions
// of "is this task ready" can never drift apart.
func promoteReadySiblings(ctx context.Context, tx pgx.Tx, tenantID, coordinatorRunID string) ([]string, error) {
	completedRows, err := tx.Query(ctx, `
		SELECT id FROM orchestration.orchestration_tasks
		WHERE coordinator_run_id = $1 AND tenant_id = $2 AND status = 'completed'
	`, coordinatorRunID, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query completed siblings: %w", err)
	}
	completed := map[string]struct{}{}
	for completedRows.Next() {
		var id string
		if err := completedRows.Scan(&id); err != nil {
			completedRows.Close()
			return nil, fmt.Errorf("postgres: scan completed sibling id: %w", err)
		}
		completed[id] = struct{}{}
	}
	completedRows.Close()
	if err := completedRows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate completed siblings: %w", err)
	}

	pendingRows, err := tx.Query(ctx, `
		SELECT id, deps FROM orchestration.orchestration_tasks
		WHERE coordinator_run_id = $1 AND tenant_id = $2 AND status = 'pending'
	`, coordinatorRunID, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query pending siblings: %w", err)
	}
	type candidate struct {
		id   string
		deps []string
	}
	var candidates []candidate
	for pendingRows.Next() {
		var c candidate
		var depsJSON []byte
		if err := pendingRows.Scan(&c.id, &depsJSON); err != nil {
			pendingRows.Close()
			return nil, fmt.Errorf("postgres: scan pending sibling: %w", err)
		}
		if err := json.Unmarshal(depsJSON, &c.deps); err != nil {
			pendingRows.Close()
			return nil, fmt.Errorf("postgres: unmarshal deps: %w", err)
		}
		candidates = append(candidates, c)
	}
	pendingRows.Close()
	if err := pendingRows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate pending siblings: %w", err)
	}

	var promoted []string
	for _, c := range candidates {
		task := domain.OrchestrationTask{Deps: c.deps}
		if task.DepsSatisfied(completed) {
			promoted = append(promoted, c.id)
		}
	}
	if len(promoted) == 0 {
		return nil, nil
	}

	if _, err := tx.Exec(ctx, `
		UPDATE orchestration.orchestration_tasks SET status = 'ready'
		WHERE id = ANY($1) AND tenant_id = $2
	`, promoted, tenantID); err != nil {
		return nil, fmt.Errorf("postgres: promote ready siblings: %w", err)
	}
	return promoted, nil
}

func scanTask(row pgx.Row) (domain.OrchestrationTask, error) {
	var task domain.OrchestrationTask
	var status string
	var specJSON, depsJSON, resultJSON []byte
	var completedAt *time.Time
	if err := row.Scan(
		&task.ID, &task.TenantID, &task.CoordinatorRunID, &task.ParentID, &task.OriginTaskID,
		&task.TaskTitle, &specJSON, &status, &depsJSON, &resultJSON, &task.CreatedAt, &completedAt,
	); err != nil {
		return domain.OrchestrationTask{}, err
	}
	task.Status = domain.TaskStatus(status)
	task.Spec = specJSON
	task.Result = resultJSON
	if completedAt != nil {
		task.CompletedAt = *completedAt
	}
	if len(depsJSON) > 0 {
		if err := json.Unmarshal(depsJSON, &task.Deps); err != nil {
			return domain.OrchestrationTask{}, fmt.Errorf("postgres: unmarshal deps: %w", err)
		}
	}
	return task, nil
}

// ---- DispatchContextRepository ------------------------------------------

// Create inserts a dispatch_context row. See usecase.DispatchContextRepository's
// doc comment (Epic C, docs/execution-plan.md): orchestrationTaskID is
// persisted when the caller supplies one (NULLIF collapses "" to NULL for
// the nullable FK), and left NULL for an ad-hoc coordinator-only dispatch —
// a single INSERT, trivially atomic on its own.
func (r *Repository) CreateDispatchContext(ctx context.Context, tenantID, userID, worktreeID, handle, coordinatorRunID, orchestrationTaskID string) (domain.DispatchContext, error) {
	id := uuid.NewString()
	// orchestration_task_id is passed as *string (nil for "no task"),
	// resolved in Go rather than via SQL's NULLIF($n,'') — pgx sends a Go
	// string parameter as `text`, and NULLIF(text, '') against a UUID
	// column fails type inference at bind time ("column ... is of type
	// uuid but expression is of type text", a real, pre-existing bug this
	// fix closes: NULLIF's result type comes from its arguments, which are
	// both text here, so Postgres never gets a chance to coerce to the
	// column's uuid type the way a bare parameter reference would).
	// user_id/worktree_id are plain TEXT columns (no such coercion issue),
	// so they keep using NULLIF directly.
	var orchestrationTaskIDArg *string
	if orchestrationTaskID != "" {
		orchestrationTaskIDArg = &orchestrationTaskID
	}
	row := r.pool.QueryRow(ctx, `
		INSERT INTO orchestration.dispatch_contexts (id, tenant_id, user_id, worktree_id, handle, coordinator_run_id, orchestration_task_id, status)
		VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),$5,$6,$7,'pending')
		RETURNING created_at
	`, id, tenantID, userID, worktreeID, handle, coordinatorRunID, orchestrationTaskIDArg)

	var createdAt time.Time
	if err := row.Scan(&createdAt); err != nil {
		return domain.DispatchContext{}, fmt.Errorf("postgres: insert dispatch context: %w", err)
	}
	return domain.DispatchContext{
		ID:                  id,
		TenantID:            tenantID,
		UserID:              userID,
		WorktreeID:          worktreeID,
		Handle:              handle,
		CoordinatorRunID:    coordinatorRunID,
		OrchestrationTaskID: orchestrationTaskID,
		Status:              domain.DispatchStatusPending,
		CreatedAt:           createdAt,
	}, nil
}

// ListActiveDispatchContextsForUser returns every non-terminal dispatch
// context for (tenantID, userID) — see usecase.DispatchContextRepository's
// doc comment. "Active" excludes completed/failed/circuit_broken; a
// circuit_broken dispatch is done trying, not still running, so it's
// excluded the same as failed/completed for this "what's currently running
// for me" view.
func (r *Repository) ListActiveDispatchContextsForUser(ctx context.Context, tenantID, userID string) ([]domain.DispatchContext, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, user_id, worktree_id, handle, coordinator_run_id, orchestration_task_id,
		       status, failure_count, last_failure, dispatched_at, completed_at,
		       last_heartbeat_at, created_at
		FROM orchestration.dispatch_contexts
		WHERE tenant_id = $1 AND user_id = $2
		  AND status NOT IN ('completed', 'failed', 'circuit_broken')
		ORDER BY created_at DESC
	`, tenantID, userID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query active dispatch contexts for user: %w", err)
	}
	defer rows.Close()

	out := []domain.DispatchContext{}
	for rows.Next() {
		var d domain.DispatchContext
		var worktreeID, orchestrationTaskID, lastFailure *string
		var dispatchedAt, completedAt, lastHeartbeatAt *time.Time
		if err := rows.Scan(
			&d.ID, &d.TenantID, &d.UserID, &worktreeID, &d.Handle, &d.CoordinatorRunID, &orchestrationTaskID,
			&d.Status, &d.FailureCount, &lastFailure, &dispatchedAt, &completedAt,
			&lastHeartbeatAt, &d.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("postgres: scan active dispatch context row: %w", err)
		}
		if worktreeID != nil {
			d.WorktreeID = *worktreeID
		}
		if orchestrationTaskID != nil {
			d.OrchestrationTaskID = *orchestrationTaskID
		}
		if lastFailure != nil {
			d.LastFailure = *lastFailure
		}
		if dispatchedAt != nil {
			d.DispatchedAt = *dispatchedAt
		}
		if completedAt != nil {
			d.CompletedAt = *completedAt
		}
		if lastHeartbeatAt != nil {
			d.LastHeartbeatAt = *lastHeartbeatAt
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate active dispatch context rows: %w", err)
	}
	return out, nil
}

// GetLatestForTask returns the most recently created dispatch_contexts row
// for orchestrationTaskID — see usecase.DispatchContextRepository's doc
// comment: a task's dispatch_contexts row is not unique (retries after
// failure create new rows), so this orders by created_at DESC and takes
// the first, matching CreateDispatchContext's own column set and
// nullable-column handling.
func (r *Repository) GetLatestForTask(ctx context.Context, tenantID, orchestrationTaskID string) (domain.DispatchContext, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, worktree_id, orchestration_task_id, handle, coordinator_run_id, status, created_at
		FROM orchestration.dispatch_contexts
		WHERE tenant_id = $1 AND orchestration_task_id = $2
		ORDER BY created_at DESC
		LIMIT 1
	`, tenantID, orchestrationTaskID)

	var dc domain.DispatchContext
	var status string
	var worktreeIDCol, orchestrationTaskIDCol *string
	if err := row.Scan(&dc.ID, &dc.TenantID, &worktreeIDCol, &orchestrationTaskIDCol, &dc.Handle, &dc.CoordinatorRunID, &status, &dc.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.DispatchContext{}, usecase.ErrDispatchContextNotFound
		}
		return domain.DispatchContext{}, fmt.Errorf("postgres: get latest dispatch context for task: %w", err)
	}
	if worktreeIDCol != nil {
		dc.WorktreeID = *worktreeIDCol
	}
	if orchestrationTaskIDCol != nil {
		dc.OrchestrationTaskID = *orchestrationTaskIDCol
	}
	dc.Status = domain.DispatchStatus(status)
	return dc, nil
}

// RecordDispatchFailure loads dispatch_contexts row id (locked, tenant-
// scoped), applies domain.DispatchContext.RecordFailure(reason) in Go, and
// persists the updated failure_count/status/last_failure — same
// SELECT...FOR UPDATE-then-write transaction shape as CreateGate below,
// applied to a single row instead of a cross-table update. See
// usecase.DispatchContextRepository's doc comment.
func (r *Repository) RecordDispatchFailure(ctx context.Context, tenantID, dispatchContextID, reason string) (domain.DispatchContext, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.DispatchContext{}, fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var dc domain.DispatchContext
	var status string
	var orchestrationTaskID, userID *string
	err = tx.QueryRow(ctx, `
		SELECT id, tenant_id, user_id, handle, coordinator_run_id, orchestration_task_id, status, failure_count
		FROM orchestration.dispatch_contexts
		WHERE id = $1 AND tenant_id = $2
		FOR UPDATE
	`, dispatchContextID, tenantID).Scan(
		&dc.ID, &dc.TenantID, &userID, &dc.Handle, &dc.CoordinatorRunID, &orchestrationTaskID, &status, &dc.FailureCount,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DispatchContext{}, usecase.ErrDispatchContextNotFound
	}
	if err != nil {
		return domain.DispatchContext{}, fmt.Errorf("postgres: query dispatch context for failure record: %w", err)
	}
	if userID != nil {
		dc.UserID = *userID
	}
	if orchestrationTaskID != nil {
		dc.OrchestrationTaskID = *orchestrationTaskID
	}
	dc.Status = domain.DispatchStatus(status)

	updated := dc.RecordFailure(reason)

	if _, err := tx.Exec(ctx, `
		UPDATE orchestration.dispatch_contexts
		SET failure_count = $1, status = $2, last_failure = $3
		WHERE id = $4 AND tenant_id = $5
	`, updated.FailureCount, string(updated.Status), updated.LastFailure, dispatchContextID, tenantID); err != nil {
		return domain.DispatchContext{}, fmt.Errorf("postgres: update dispatch context failure: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.DispatchContext{}, fmt.Errorf("postgres: commit dispatch failure tx: %w", err)
	}
	return updated, nil
}

// ---- GateRepository -------------------------------------------------

// CreateGate atomically resolves dispatchContextID to its owning
// orchestration_task_id, inserts the gate row, and transitions that task to
// blocked — all in one transaction (§8). Returns
// usecase.ErrDispatchContextHasNoTask if the dispatch context has no
// orchestration_task_id yet (see the CreateDispatchContext doc comment
// above and README "Known gaps": that is the expected state for every
// dispatch context created through the current proto surface, until it is
// extended).
func (r *Repository) CreateGate(ctx context.Context, tenantID, dispatchContextID, question string, options []string) (domain.DecisionGate, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.DecisionGate{}, fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var orchestrationTaskID *string
	err = tx.QueryRow(ctx, `
		SELECT orchestration_task_id FROM orchestration.dispatch_contexts
		WHERE id = $1 AND tenant_id = $2
		FOR UPDATE
	`, dispatchContextID, tenantID).Scan(&orchestrationTaskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DecisionGate{}, usecase.ErrDispatchContextNotFound
	}
	if err != nil {
		return domain.DecisionGate{}, fmt.Errorf("postgres: query dispatch context: %w", err)
	}
	if orchestrationTaskID == nil || *orchestrationTaskID == "" {
		return domain.DecisionGate{}, usecase.ErrDispatchContextHasNoTask
	}

	optionsJSON, err := json.Marshal(options)
	if err != nil {
		return domain.DecisionGate{}, fmt.Errorf("postgres: marshal options: %w", err)
	}

	id := uuid.NewString()
	var createdAt time.Time
	err = tx.QueryRow(ctx, `
		INSERT INTO orchestration.decision_gates (
			id, tenant_id, orchestration_task_id, dispatch_context_id, question, options, status
		) VALUES ($1,$2,$3,$4,$5,$6,'pending')
		RETURNING created_at
	`, id, tenantID, *orchestrationTaskID, dispatchContextID, question, optionsJSON).Scan(&createdAt)
	if err != nil {
		return domain.DecisionGate{}, fmt.Errorf("postgres: insert decision gate: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE orchestration.orchestration_tasks SET status = 'blocked'
		WHERE id = $1 AND tenant_id = $2
	`, *orchestrationTaskID, tenantID); err != nil {
		return domain.DecisionGate{}, fmt.Errorf("postgres: block owning task: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.DecisionGate{}, fmt.Errorf("postgres: commit tx: %w", err)
	}

	return domain.DecisionGate{
		ID:                  id,
		TenantID:            tenantID,
		OrchestrationTaskID: *orchestrationTaskID,
		DispatchContextID:   dispatchContextID,
		Question:            question,
		Options:             options,
		Status:              domain.GateStatusPending,
		CreatedAt:           createdAt,
	}, nil
}

// ResolveGate atomically transitions the gate to resolved and unblocks its
// owning task — all in one transaction (§8). The row is locked
// (SELECT ... FOR UPDATE) before the pending check so two concurrent
// ResolveGate calls for the same gate can never both observe "pending" —
// enforcing domain.ErrGateAlreadyResolved's invariant even under a race
// (defense in depth alongside the usecase-level HandleSerializer keying).
func (r *Repository) ResolveGate(ctx context.Context, tenantID, gateID, resolution string) (domain.DecisionGate, []string, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return domain.DecisionGate{}, nil, fmt.Errorf("postgres: begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var gate domain.DecisionGate
	var status string
	var dispatchContextID *string
	var optionsJSON []byte
	var resolvedAt *time.Time
	err = tx.QueryRow(ctx, `
		SELECT id, tenant_id, orchestration_task_id, dispatch_context_id, question, options, status, resolution, created_at, resolved_at
		FROM orchestration.decision_gates
		WHERE id = $1 AND tenant_id = $2
		FOR UPDATE
	`, gateID, tenantID).Scan(
		&gate.ID, &gate.TenantID, &gate.OrchestrationTaskID, &dispatchContextID, &gate.Question, &optionsJSON,
		&status, &gate.Resolution, &gate.CreatedAt, &resolvedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DecisionGate{}, nil, usecase.ErrGateNotFound
	}
	if err != nil {
		return domain.DecisionGate{}, nil, fmt.Errorf("postgres: query decision gate: %w", err)
	}
	if status != string(domain.GateStatusPending) {
		return domain.DecisionGate{}, nil, usecase.ErrGateNotPending
	}
	if dispatchContextID != nil {
		gate.DispatchContextID = *dispatchContextID
	}
	if len(optionsJSON) > 0 {
		if err := json.Unmarshal(optionsJSON, &gate.Options); err != nil {
			return domain.DecisionGate{}, nil, fmt.Errorf("postgres: unmarshal gate options: %w", err)
		}
	}

	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `
		UPDATE orchestration.decision_gates SET status = 'resolved', resolution = $1, resolved_at = $2
		WHERE id = $3
	`, resolution, now, gateID); err != nil {
		return domain.DecisionGate{}, nil, fmt.Errorf("postgres: resolve decision gate: %w", err)
	}

	// Resolving a gate unblocks the task it was gating; that task moves
	// straight to ready rather than pending because a blocked task's deps
	// (if any) were already satisfied at the point it became blocked — a
	// gate blocks dispatch, not dependency completion. There is no further
	// "promotion pass" over siblings here (unlike UpdateStatusAndPromote):
	// promotion is triggered by a task reaching *completed*, and resolving
	// a gate doesn't complete anything.
	if _, err := tx.Exec(ctx, `
		UPDATE orchestration.orchestration_tasks SET status = 'ready'
		WHERE id = $1 AND tenant_id = $2 AND status = 'blocked'
	`, gate.OrchestrationTaskID, tenantID); err != nil {
		return domain.DecisionGate{}, nil, fmt.Errorf("postgres: unblock owning task: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return domain.DecisionGate{}, nil, fmt.Errorf("postgres: commit tx: %w", err)
	}

	gate.Status = domain.GateStatusResolved
	gate.Resolution = resolution
	gate.ResolvedAt = now
	return gate, []string{gate.OrchestrationTaskID}, nil
}
