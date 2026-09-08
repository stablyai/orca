package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// EphemeralVmRuntimeStore implements usecase.EphemeralVmRuntimeRepository —
// a separate struct + table from the giant Repository, same reason
// BrowserProfileStore is separate (see that type's doc comment).
type EphemeralVmRuntimeStore struct {
	pool *pgxpool.Pool
}

func NewEphemeralVmRuntimeStore(pool *pgxpool.Pool) *EphemeralVmRuntimeStore {
	return &EphemeralVmRuntimeStore{pool: pool}
}

// List returns every non-destroyed runtime for tenantID — backs
// ListEphemeralVmRuntimes (TASK-002); Create/UpdateStatus (TASK-004) write
// to the same table.
func (s *EphemeralVmRuntimeStore) List(ctx context.Context, tenantID string) ([]domain.EphemeralVmRuntime, error) {
	const q = `
		SELECT id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		       COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at
		FROM infra.ephemeral_vm_runtimes
		WHERE tenant_id = $1 AND status <> 'destroyed'
		ORDER BY created_at`
	rows, err := s.pool.Query(ctx, q, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: listing ephemeral vm runtimes: %w", err)
	}
	defer rows.Close()

	var out []domain.EphemeralVmRuntime
	for rows.Next() {
		var r domain.EphemeralVmRuntime
		if err := rows.Scan(&r.ID, &r.RepoID, &r.RecipeID, &r.ConnectionType, &r.Status,
			&r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, fmt.Errorf("postgres: scanning ephemeral vm runtime row: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Get backs EphemeralVmRelay.CleanupWorkspace (TASK-BE-EVM-001), which only
// receives a runtimeID (not a workspaceID) and needs the runtime's
// RecipeID before relaying vm.exec.
func (s *EphemeralVmRuntimeStore) Get(ctx context.Context, tenantID, id string) (domain.EphemeralVmRuntime, error) {
	const q = `
		SELECT id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		       COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at
		FROM infra.ephemeral_vm_runtimes
		WHERE tenant_id = $1 AND id = $2 AND status <> 'destroyed'`
	var r domain.EphemeralVmRuntime
	err := s.pool.QueryRow(ctx, q, tenantID, id).Scan(&r.ID, &r.RepoID, &r.RecipeID, &r.ConnectionType,
		&r.Status, &r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	if err != nil {
		return domain.EphemeralVmRuntime{}, fmt.Errorf("postgres: get ephemeral vm runtime: %w", err)
	}
	return r, nil
}

// GetByWorkspaceID backs EphemeralVmRelay.SuspendWorkspace/ResumeWorkspace
// (TASK-004), which look up the runtime attached to a workspace/worktree id.
func (s *EphemeralVmRuntimeStore) GetByWorkspaceID(ctx context.Context, tenantID, workspaceID string) (domain.EphemeralVmRuntime, error) {
	const q = `
		SELECT id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		       COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at
		FROM infra.ephemeral_vm_runtimes
		WHERE tenant_id = $1 AND workspace_id = $2 AND status <> 'destroyed'`
	var r domain.EphemeralVmRuntime
	err := s.pool.QueryRow(ctx, q, tenantID, workspaceID).Scan(&r.ID, &r.RepoID, &r.RecipeID, &r.ConnectionType,
		&r.Status, &r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	if err != nil {
		return domain.EphemeralVmRuntime{}, fmt.Errorf("postgres: get ephemeral vm runtime by workspace: %w", err)
	}
	return r, nil
}

// UpdateStatus applies a partial update — status is always set; the other
// fields are only touched when non-empty (workspaceID)/explicitly passed
// (lastError, which callers pass "" to clear on a successful transition).
func (s *EphemeralVmRuntimeStore) UpdateStatus(ctx context.Context, tenantID, id, status, workspaceID, lastError string) (domain.EphemeralVmRuntime, error) {
	const q = `
		UPDATE infra.ephemeral_vm_runtimes
		SET status = $3,
		    workspace_id = COALESCE(NULLIF($4, ''), workspace_id),
		    last_error = NULLIF($5, ''),
		    updated_at = now()
		WHERE tenant_id = $1 AND id = $2
		RETURNING id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		          COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at`
	var r domain.EphemeralVmRuntime
	err := s.pool.QueryRow(ctx, q, tenantID, id, status, workspaceID, lastError).Scan(&r.ID, &r.RepoID, &r.RecipeID,
		&r.ConnectionType, &r.Status, &r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	if err != nil {
		return domain.EphemeralVmRuntime{}, fmt.Errorf("postgres: update ephemeral vm runtime status: %w", err)
	}
	return r, nil
}

// UpdateProvisionResult applies a partial update like UpdateStatus, plus
// connection_type — backs EphemeralVmRelay.Provision (TASK-BE-EVM-004),
// which must persist which branch ("orca-server" | "ssh") vm.provision's
// terminal result resolved to.
func (s *EphemeralVmRuntimeStore) UpdateProvisionResult(ctx context.Context, tenantID, id, status, connectionType, lastError string) (domain.EphemeralVmRuntime, error) {
	const q = `
		UPDATE infra.ephemeral_vm_runtimes
		SET status = $3,
		    connection_type = COALESCE(NULLIF($4, ''), connection_type),
		    last_error = NULLIF($5, ''),
		    updated_at = now()
		WHERE tenant_id = $1 AND id = $2
		RETURNING id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		          COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at`
	var r domain.EphemeralVmRuntime
	err := s.pool.QueryRow(ctx, q, tenantID, id, status, connectionType, lastError).Scan(&r.ID, &r.RepoID, &r.RecipeID,
		&r.ConnectionType, &r.Status, &r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	if err != nil {
		return domain.EphemeralVmRuntime{}, fmt.Errorf("postgres: update ephemeral vm runtime provision result: %w", err)
	}
	return r, nil
}

// SetEnvironmentID writes the real dev_servers.id PK onto runtimeID's
// environment_id column — see the interface method's doc comment
// (list_ephemeral_vm_runtimes.go) for why the caller lives outside this
// package (agentwsserver.TokenIssuer.handlePost, not EphemeralVmRelay).
// pgx.ErrNoRows (no runtime row with this id/tenant — the overwhelmingly
// common case, since most agents minting a token are not ephemeral VMs)
// is surfaced as domain.ErrEphemeralVmRuntimeNotFound so callers can treat
// it as a silent no-op, matching Get/GetByWorkspaceID/UpdateStatus's own
// not-found convention in this file.
func (s *EphemeralVmRuntimeStore) SetEnvironmentID(ctx context.Context, tenantID, runtimeID, environmentID string) (domain.EphemeralVmRuntime, error) {
	const q = `
		UPDATE infra.ephemeral_vm_runtimes
		SET environment_id = $3, updated_at = now()
		WHERE tenant_id = $1 AND id = $2
		RETURNING id, repo_id, recipe_id, connection_type, status, COALESCE(environment_id, ''),
		          COALESCE(workspace_id, ''), COALESCE(last_error, ''), created_at, updated_at`
	var r domain.EphemeralVmRuntime
	err := s.pool.QueryRow(ctx, q, tenantID, runtimeID, environmentID).Scan(&r.ID, &r.RepoID, &r.RecipeID,
		&r.ConnectionType, &r.Status, &r.EnvironmentID, &r.WorkspaceID, &r.LastError, &r.CreatedAt, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
	}
	if err != nil {
		return domain.EphemeralVmRuntime{}, fmt.Errorf("postgres: set ephemeral vm runtime environment id: %w", err)
	}
	return r, nil
}

// FindDevServerByEnvironmentID backs SpawnTerminalSession's environmentId
// resolution fallback (TASK-BE-EVM-007) — see the interface method's doc
// comment for why this returns environmentID itself as devServerID rather
// than a distinct column value.
func (s *EphemeralVmRuntimeStore) FindDevServerByEnvironmentID(ctx context.Context, tenantID, environmentID string) (string, bool, error) {
	const q = `
		SELECT 1 FROM infra.ephemeral_vm_runtimes
		WHERE tenant_id = $1 AND environment_id = $2 AND status <> 'destroyed'
		LIMIT 1`
	var exists int
	err := s.pool.QueryRow(ctx, q, tenantID, environmentID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("postgres: find dev server by environment id: %w", err)
	}
	return environmentID, true, nil
}
