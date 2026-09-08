// Package postgres implements task-service's TaskRepository, EdgeRepository,
// and GrantRepository ports (defined in internal/usecase) against this
// service's own PostgreSQL database — see
// specs/backend-go/architecture/05-data-architecture.md's
// database-per-service rule: this is the ONLY package in task-service that
// knows SQL exists.
//
// Hand-written SQL via pgx, not sqlc codegen — task-service.md §6 names
// sqlc (with hand-written recursive CTEs) as the chosen approach for this
// service specifically, but this scaffold hand-writes the equivalent
// queries directly to avoid an extra build-time toolchain dependency, same
// posture as usage-service's adapter/postgres. Add a sqlc.yaml + regenerate
// once the query set stabilizes — see this service's README.
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/task-service/internal/domain"
	"github.com/stablyai/orca-go/services/task-service/internal/usecase"
)

// dbtx abstracts over the subset of *pgxpool.Pool and pgx.Tx methods this
// package's query methods need — mirrors credential-broker-service's own
// postgres.dbtx (internal/adapter/postgres/repository.go in that service)
// so RunInTx below can hand AIApply a Repository scoped to an open
// transaction without duplicating any SQL between the pooled and
// transactional paths.
type dbtx interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// Repository implements usecase.TaskRepository, usecase.EdgeRepository, and
// usecase.GrantRepository against Postgres via pgx — one struct, one pool,
// same shape as usage-service/internal/adapter/postgres.Repository. It also
// implements usecase.TxRunner (see RunInTx below), closing TASK-224 Gap 2 —
// see ai_apply.go's doc comment for why AIApply needs this.
type Repository struct {
	pool *pgxpool.Pool
	db   dbtx // == pool outside a transaction; == a pgx.Tx inside RunInTx's fn
}

func New(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool, db: pool}
}

// RunInTx implements usecase.TxRunner: opens one Postgres transaction via
// pgx.BeginFunc (commits on fn returning nil, rolls back and returns fn's
// error otherwise) and hands fn a Repository scoped to that transaction —
// same pattern as credential-broker-service.Repository.RunInTx, reusing the
// exact TaskRepository/EdgeRepository port shapes AIApply's CreateTask/
// AddEdge sub-usecases already call, rather than introducing
// transaction-specific interfaces.
func (r *Repository) RunInTx(ctx context.Context, fn func(ctx context.Context, tasks usecase.TaskRepository, edges usecase.EdgeRepository) error) error {
	return pgx.BeginFunc(ctx, r.pool, func(tx pgx.Tx) error {
		scoped := &Repository{pool: r.pool, db: tx}
		return fn(ctx, scoped, scoped)
	})
}

func (r *Repository) Create(ctx context.Context, task domain.Task) (domain.Task, error) {
	_, err := r.db.Exec(ctx, `
		INSERT INTO task.tasks (id, tenant_id, title, status, parent_id, project_id)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, task.ID, task.TenantID, task.Title, task.Status, nullableUUID(task.ParentID), nullableUUID(task.ProjectID))
	if err != nil {
		return domain.Task{}, fmt.Errorf("postgres: insert task: %w", err)
	}
	return task, nil
}

func (r *Repository) Get(ctx context.Context, tenantID, id string) (domain.Task, error) {
	row := r.db.QueryRow(ctx, `
		SELECT id, tenant_id, title, status, COALESCE(parent_id::text, ''), COALESCE(project_id::text, ''), COALESCE(workflow_template_id::text, '')
		FROM task.tasks
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, id)

	var t domain.Task
	if err := row.Scan(&t.ID, &t.TenantID, &t.Title, &t.Status, &t.ParentID, &t.ProjectID, &t.WorkflowTemplateID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Task{}, fmt.Errorf("postgres: task %s not found: %w", id, err)
		}
		return domain.Task{}, fmt.Errorf("postgres: query task: %w", err)
	}
	return t, nil
}

// GetAncestors walks tasks.parent_id from id up to the root via one
// WITH RECURSIVE query, per task-service.md §6's query-shape note and §8's
// max-depth guard (bounded by the depth column in the recursive term, not
// re-queried per hop). The first row is id itself; the last is the root.
func (r *Repository) GetAncestors(ctx context.Context, tenantID, id string, maxDepth int) ([]domain.Task, error) {
	if maxDepth <= 0 {
		maxDepth = domain.DefaultMaxAncestorDepth
	}

	rows, err := r.db.Query(ctx, `
		WITH RECURSIVE ancestors AS (
			SELECT id, tenant_id, title, status, parent_id, project_id, workflow_template_id, 0 AS depth
			FROM task.tasks
			WHERE tenant_id = $1 AND id = $2

			UNION ALL

			SELECT t.id, t.tenant_id, t.title, t.status, t.parent_id, t.project_id, t.workflow_template_id, a.depth + 1
			FROM task.tasks t
			JOIN ancestors a ON t.id = a.parent_id
			WHERE a.depth + 1 < $3
		)
		SELECT id, tenant_id, title, status, COALESCE(parent_id::text, ''), COALESCE(project_id::text, ''), COALESCE(workflow_template_id::text, '')
		FROM ancestors
		ORDER BY depth
	`, tenantID, id, maxDepth)
	if err != nil {
		return nil, fmt.Errorf("postgres: query ancestors: %w", err)
	}
	defer rows.Close()

	var out []domain.Task
	for rows.Next() {
		var t domain.Task
		if err := rows.Scan(&t.ID, &t.TenantID, &t.Title, &t.Status, &t.ParentID, &t.ProjectID, &t.WorkflowTemplateID); err != nil {
			return nil, fmt.Errorf("postgres: scan ancestor row: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate ancestor rows: %w", err)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("postgres: task %s not found while resolving ancestors", id)
	}
	return out, nil
}

// UpdateStatus persists a task's status transition — see
// usecase.TaskRepository's doc comment for the one-way-transition caveat
// this method is currently subject to (only ever called with
// StatusInProgress today).
func (r *Repository) UpdateStatus(ctx context.Context, tenantID, id, status string) error {
	tag, err := r.db.Exec(ctx, `UPDATE task.tasks SET status = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3`, status, tenantID, id)
	if err != nil {
		return fmt.Errorf("postgres: update task status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: task %s not found", id)
	}
	return nil
}

// HasActiveExecutions reports whether tenantID/projectID has any task
// currently in_progress — see usecase.HasActiveExecutions's doc comment for
// the one-way-transition caveat this answer is subject to today.
func (r *Repository) HasActiveExecutions(ctx context.Context, tenantID, projectID string) (bool, error) {
	row := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task.tasks WHERE tenant_id = $1 AND project_id = $2 AND status = 'in_progress')`, tenantID, projectID)
	var exists bool
	if err := row.Scan(&exists); err != nil {
		return false, fmt.Errorf("postgres: query has-active-executions: %w", err)
	}
	return exists, nil
}

// List returns tasks for tenantID, optionally filtered by projectID (empty
// = no filter), ordered and cursor-paginated by id — same shape as
// GetAncestors's plain SELECT (no recursive CTE needed here).
func (r *Repository) List(ctx context.Context, tenantID, projectID, pageToken string, pageSize int32) ([]domain.Task, string, error) {
	if pageSize <= 0 {
		pageSize = 50
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, tenant_id, title, status, COALESCE(parent_id::text, ''), COALESCE(project_id::text, ''), COALESCE(workflow_template_id::text, '')
		FROM task.tasks
		WHERE tenant_id = $1
		  AND ($2 = '' OR project_id::text = $2)
		  AND ($3 = '' OR id::text > $3)
		ORDER BY id
		LIMIT $4
	`, tenantID, projectID, pageToken, pageSize)
	if err != nil {
		return nil, "", fmt.Errorf("postgres: query tasks: %w", err)
	}
	defer rows.Close()

	var out []domain.Task
	for rows.Next() {
		var t domain.Task
		if err := rows.Scan(&t.ID, &t.TenantID, &t.Title, &t.Status, &t.ParentID, &t.ProjectID, &t.WorkflowTemplateID); err != nil {
			return nil, "", fmt.Errorf("postgres: scan task row: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("postgres: iterate task rows: %w", err)
	}
	nextToken := ""
	if len(out) == int(pageSize) {
		nextToken = out[len(out)-1].ID
	}
	return out, nextToken, nil
}

// Update persists a partial (title/status/workflow_template_id) field
// update — the status guard itself runs at the domain layer
// (domain.Task.SetStatus) before this is ever called; this is a plain
// UPDATE of all three columns unconditionally (UpdateTask usecase already
// merged only the caller-supplied fields onto the loaded task before
// calling this).
func (r *Repository) Update(ctx context.Context, tenantID string, t domain.Task) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE task.tasks SET title = $3, status = $4, workflow_template_id = NULLIF($5, '')::uuid, updated_at = now()
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, t.ID, t.Title, t.Status, t.WorkflowTemplateID)
	if err != nil {
		return fmt.Errorf("postgres: update task: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: task %s not found for tenant %s", t.ID, tenantID)
	}
	return nil
}

// Delete removes a task row. task_edges/task_grants reference tasks(id)
// with ON DELETE CASCADE (migrations/0001_init.up.sql) — no explicit
// edge/grant cleanup needed here.
func (r *Repository) Delete(ctx context.Context, tenantID, id string) error {
	tag, err := r.db.Exec(ctx, `DELETE FROM task.tasks WHERE tenant_id = $1 AND id = $2`, tenantID, id)
	if err != nil {
		return fmt.Errorf("postgres: delete task: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: task %s not found for tenant %s", id, tenantID)
	}
	return nil
}

func nullableUUID(id string) any {
	if id == "" {
		return nil
	}
	return id
}
