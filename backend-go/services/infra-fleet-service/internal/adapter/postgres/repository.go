// Package postgres implements infra-fleet-service's DevServerRepository,
// SshTargetRepository, ConnectionRepository, ConnectionResolver, and
// FleetHealthPort ports (defined in internal/usecase), plus
// adapter/sshrelay.SshTargetResolver (a structurally-identical interface
// that package declares for itself, per this codebase's Dependency
// Inversion convention), against this service's own PostgreSQL database —
// see specs/backend-go/architecture/05-data-architecture.md's
// database-per-service rule: this is the ONLY package in infra-fleet-service
// that knows SQL exists.
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/common/outbox"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// Repository implements usecase.DevServerRepository, usecase.ConnectionRepository,
// usecase.ConnectionResolver, and usecase.FleetHealthPort — one Postgres
// connection pool, several narrow ports, matching usage-service's single
// Repository shape (see that service's internal/adapter/postgres for the
// reference pattern). SSH-target persistence lives on the separate
// SshTargetStore type below (same pool) rather than here — Go's method sets
// allow only one method per name per receiver, and
// DevServerRepository.Get(...) domain.DevServer and
// SshTargetRepository.Get(...) domain.SshTarget both need the name "Get".
type Repository struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Repository {
	return &Repository{pool: pool}
}

// Register inserts a new dev server and returns the persisted row.
// SSHTargetID is stored as NULL when empty (non-relay-ssh modes) — NULLIF
// against an empty string keeps the FK to infra.ssh_targets satisfiable
// without a sentinel row. The explicit ::uuid cast matters: NULLIF's result
// is text-typed on its own, and Postgres won't implicitly assign text (even
// a NULL text) into a uuid column.
func (r *Repository) Register(ctx context.Context, ds domain.DevServer) (domain.DevServer, error) {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO infra.dev_servers (id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind)
		VALUES ($1, $2, $3, $4, NULLIF($5, '')::uuid, $6, NULLIF($7, '')::uuid, $8)
	`, ds.ID, ds.TenantID, ds.Host, string(ds.Mode), ds.SSHTargetID, string(ds.Status), ds.GroupID, string(ds.Kind))
	if err != nil {
		return domain.DevServer{}, fmt.Errorf("postgres: insert dev server: %w", err)
	}
	return ds, nil
}

// Get fetches a dev server scoped to tenantID — a mismatched tenant_id
// (even for a correctly-guessed UUID) must never return a row, per
// specs/backend-go/services/infra-fleet-service.md §9.
func (r *Repository) Get(ctx context.Context, tenantID, id string) (domain.DevServer, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind, status
		FROM infra.dev_servers
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, id)

	var ds domain.DevServer
	var mode, status, kind, healthStatus string
	var sshTargetID, groupID *string
	err := row.Scan(&ds.ID, &ds.TenantID, &ds.Host, &mode, &sshTargetID, &status, &groupID, &kind, &healthStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DevServer{}, fmt.Errorf("postgres: dev server %q not found for tenant: %w", id, err)
	}
	if err != nil {
		return domain.DevServer{}, fmt.Errorf("postgres: query dev server: %w", err)
	}
	ds.Mode = domain.ConnectionMode(mode)
	ds.Status = domain.DevServerStatus(status)
	ds.Kind = domain.AgentKind(kind)
	ds.HealthStatus = domain.DevServerHealthStatus(healthStatus)
	if sshTargetID != nil {
		ds.SSHTargetID = *sshTargetID
	}
	if groupID != nil {
		ds.GroupID = *groupID
	}
	return ds, nil
}

// List returns every dev server registered for tenantID.
func (r *Repository) List(ctx context.Context, tenantID string) ([]domain.DevServer, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind, status
		FROM infra.dev_servers
		WHERE tenant_id = $1
		ORDER BY created_at DESC
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query dev servers: %w", err)
	}
	defer rows.Close()

	var out []domain.DevServer
	for rows.Next() {
		var ds domain.DevServer
		var mode, status, kind, healthStatus string
		var sshTargetID, groupID *string
		if err := rows.Scan(&ds.ID, &ds.TenantID, &ds.Host, &mode, &sshTargetID, &status, &groupID, &kind, &healthStatus); err != nil {
			return nil, fmt.Errorf("postgres: scan dev server row: %w", err)
		}
		ds.Mode = domain.ConnectionMode(mode)
		ds.Status = domain.DevServerStatus(status)
		ds.Kind = domain.AgentKind(kind)
		ds.HealthStatus = domain.DevServerHealthStatus(healthStatus)
		if sshTargetID != nil {
			ds.SSHTargetID = *sshTargetID
		}
		if groupID != nil {
			ds.GroupID = *groupID
		}
		out = append(out, ds)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate dev server rows: %w", err)
	}
	return out, nil
}

// UpdateApprovalStatus sets a dev server's approval_status, scoped to
// tenantID — CR-DS-006 Phase 2.
func (r *Repository) UpdateApprovalStatus(ctx context.Context, tenantID, devServerID string, status domain.DevServerStatus) (domain.DevServer, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE infra.dev_servers
		SET approval_status = $3
		WHERE tenant_id = $1 AND id = $2
		RETURNING id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind, status
	`, tenantID, devServerID, string(status))
	return scanDevServerRow(row)
}

// AssignGroup sets (or, when groupID == "", clears) a dev server's
// group_id, scoped to tenantID — CR-DS-006 Phase 2. NULLIF(groupID, ”)
// makes an empty string clear the FK to NULL, same pattern
// Register/ssh_target_id already uses.
func (r *Repository) AssignGroup(ctx context.Context, tenantID, devServerID, groupID string) (domain.DevServer, error) {
	row := r.pool.QueryRow(ctx, `
		UPDATE infra.dev_servers
		SET group_id = NULLIF($3, '')::uuid
		WHERE tenant_id = $1 AND id = $2
		RETURNING id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind, status
	`, tenantID, devServerID, groupID)
	return scanDevServerRow(row)
}

// scanDevServerRow factors out the 9-column dev_servers row scan shared by
// UpdateApprovalStatus/AssignGroup's RETURNING clauses.
func scanDevServerRow(row pgx.Row) (domain.DevServer, error) {
	var ds domain.DevServer
	var mode, status, kind, healthStatus string
	var sshTargetID, groupID *string
	err := row.Scan(&ds.ID, &ds.TenantID, &ds.Host, &mode, &sshTargetID, &status, &groupID, &kind, &healthStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DevServer{}, fmt.Errorf("postgres: dev server not found for tenant: %w", err)
	}
	if err != nil {
		return domain.DevServer{}, fmt.Errorf("postgres: update dev server: %w", err)
	}
	ds.Mode = domain.ConnectionMode(mode)
	ds.Status = domain.DevServerStatus(status)
	ds.Kind = domain.AgentKind(kind)
	ds.HealthStatus = domain.DevServerHealthStatus(healthStatus)
	if sshTargetID != nil {
		ds.SSHTargetID = *sshTargetID
	}
	if groupID != nil {
		ds.GroupID = *groupID
	}
	return ds, nil
}

// SshTargetStore implements usecase.SshTargetRepository and
// adapter/sshrelay.SshTargetResolver against the same infra.ssh_targets
// table Repository's ResolveConnection/GetFleetHealth etc. read from — split
// into its own type rather than a method on Repository, see Repository's
// doc comment for why (the Get method-name collision with
// DevServerRepository.Get).
type SshTargetStore struct {
	pool *pgxpool.Pool
}

// NewSshTargetStore builds an SshTargetStore over the same pool Repository
// uses — both are thin wrappers over one PostgreSQL connection pool, per
// architecture/05-data-architecture.md's database-per-service rule; this
// just isn't the SAME Go value as Repository (see Repository's doc comment).
func NewSshTargetStore(pool *pgxpool.Pool) *SshTargetStore {
	return &SshTargetStore{pool: pool}
}

// Create inserts a new SSH target and returns the persisted row.
func (s *SshTargetStore) Create(ctx context.Context, target domain.SshTarget) (domain.SshTarget, error) {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO infra.ssh_targets (id, tenant_id, host, user_name, vault_ssh_role)
		VALUES ($1, $2, $3, $4, $5)
	`, target.ID, target.TenantID, target.Host, target.UserName, target.VaultSSHRole)
	if err != nil {
		return domain.SshTarget{}, fmt.Errorf("postgres: insert ssh target: %w", err)
	}
	return target, nil
}

// List returns every SSH target registered for tenantID.
func (s *SshTargetStore) List(ctx context.Context, tenantID string) ([]domain.SshTarget, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, host, user_name, vault_ssh_role
		FROM infra.ssh_targets
		WHERE tenant_id = $1
		ORDER BY host
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query ssh targets: %w", err)
	}
	defer rows.Close()

	var out []domain.SshTarget
	for rows.Next() {
		var t domain.SshTarget
		if err := rows.Scan(&t.ID, &t.TenantID, &t.Host, &t.UserName, &t.VaultSSHRole); err != nil {
			return nil, fmt.Errorf("postgres: scan ssh target row: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate ssh target rows: %w", err)
	}
	return out, nil
}

// Get fetches an SSH target scoped to tenantID — implements both
// usecase.SshTargetRepository and adapter/sshrelay.SshTargetResolver (the
// latter consumed by sshrelay.Provisioner to resolve DevServer.SSHTargetID
// before dialing via sshconn.Connector for relay-ssh mode).
func (s *SshTargetStore) Get(ctx context.Context, tenantID, id string) (domain.SshTarget, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT id, tenant_id, host, user_name, vault_ssh_role
		FROM infra.ssh_targets
		WHERE tenant_id = $1 AND id = $2
	`, tenantID, id)

	var target domain.SshTarget
	err := row.Scan(&target.ID, &target.TenantID, &target.Host, &target.UserName, &target.VaultSSHRole)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SshTarget{}, fmt.Errorf("postgres: ssh target %q not found for tenant: %w", id, err)
	}
	if err != nil {
		return domain.SshTarget{}, fmt.Errorf("postgres: query ssh target: %w", err)
	}
	return target, nil
}

// ResolveConnection is the storage-backed half of THE core coordination
// primitive — see usecase.ConnectionResolver's doc comment.
//
// Joins infra.connections -> infra.dev_servers within tenantID's scope
// (migrations/0002_connections) — the real routing model that replaced this
// scaffold's original connectionId==dev_server.id equation. See this
// service's README "Known gaps" for what still isn't wired (port_forwards,
// provider_registry_entries, terminal_sessions).
func (r *Repository) ResolveConnection(ctx context.Context, tenantID, connectionID string) (bool, domain.DevServer, domain.Connection, error) {
	const q = `
		SELECT c.id, c.tenant_id, c.dev_server_id, c.repo_path, c.worktree_id,
		       ds.id, ds.tenant_id, ds.host, ds.connection_mode
		FROM infra.connections c
		JOIN infra.dev_servers ds ON ds.id = c.dev_server_id
		WHERE c.tenant_id = $1 AND c.id = $2`
	return r.scanConnectionRow(ctx, q, tenantID, connectionID)
}

// ResolveConnectionByDevServer is ResolveConnection's reverse-lookup
// counterpart — see usecase.ConnectionResolver's doc comment (TASK-025).
// A dev server can have had multiple connection rows over time — resolves
// the most recently created one.
func (r *Repository) ResolveConnectionByDevServer(ctx context.Context, tenantID, devServerID string) (bool, domain.DevServer, domain.Connection, error) {
	const q = `
		SELECT c.id, c.tenant_id, c.dev_server_id, c.repo_path, c.worktree_id,
		       ds.id, ds.tenant_id, ds.host, ds.connection_mode
		FROM infra.connections c
		JOIN infra.dev_servers ds ON ds.id = c.dev_server_id
		WHERE c.tenant_id = $1 AND c.dev_server_id = $2
		ORDER BY c.created_at DESC
		LIMIT 1`
	return r.scanConnectionRow(ctx, q, tenantID, devServerID)
}

// ResolveConnectionByWorktree is ResolveConnection's worktree-keyed
// counterpart — see usecase.ConnectionResolver's doc comment (TASK-025).
func (r *Repository) ResolveConnectionByWorktree(ctx context.Context, tenantID, worktreeID string) (bool, domain.DevServer, domain.Connection, error) {
	const q = `
		SELECT c.id, c.tenant_id, c.dev_server_id, c.repo_path, c.worktree_id,
		       ds.id, ds.tenant_id, ds.host, ds.connection_mode
		FROM infra.connections c
		JOIN infra.dev_servers ds ON ds.id = c.dev_server_id
		WHERE c.tenant_id = $1 AND c.worktree_id = $2
		ORDER BY c.created_at DESC
		LIMIT 1`
	return r.scanConnectionRow(ctx, q, tenantID, worktreeID)
}

// scanConnectionRow factors out ResolveConnection/ResolveConnectionByDevServer/
// ResolveConnectionByWorktree's shared row-scan + "no rows means
// connected=false, not an error" handling (TASK-025) — same column order,
// same pgx.ErrNoRows branch, so all three callers share it instead of
// duplicating the scan 3 ways.
func (r *Repository) scanConnectionRow(ctx context.Context, query string, args ...any) (bool, domain.DevServer, domain.Connection, error) {
	row := r.pool.QueryRow(ctx, query, args...)

	var conn domain.Connection
	var ds domain.DevServer
	var mode string
	err := row.Scan(
		&conn.ID, &conn.TenantID, &conn.DevServerID, &conn.RepoPath, &conn.WorktreeID,
		&ds.ID, &ds.TenantID, &ds.Host, &mode,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		// No dev server owns this connectionId within this tenant — not an
		// error, the caller's cue to execute locally.
		return false, domain.DevServer{}, domain.Connection{}, nil
	}
	if err != nil {
		return false, domain.DevServer{}, domain.Connection{}, fmt.Errorf("postgres: resolve connection: %w", err)
	}
	ds.Mode = domain.ConnectionMode(mode)
	return true, ds, conn, nil
}

// CreateConnection inserts a new connection binding and returns the
// persisted row — the write side ResolveConnection's join reads from.
func (r *Repository) CreateConnection(ctx context.Context, conn domain.Connection) (domain.Connection, error) {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO infra.connections (id, tenant_id, dev_server_id, repo_path, worktree_id, status, last_activity_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, conn.ID, conn.TenantID, conn.DevServerID, conn.RepoPath, conn.WorktreeID, conn.Status, conn.LastActivityAt)
	if err != nil {
		return domain.Connection{}, fmt.Errorf("postgres: insert connection: %w", err)
	}
	return conn, nil
}

// GetActiveByDevServer returns the most recent connection for devServerID
// whose status is not "closed" — see Connection.Status's doc comment
// (migrations/0004_connection_status).
func (r *Repository) GetActiveByDevServer(ctx context.Context, tenantID, devServerID string) (domain.Connection, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, dev_server_id, repo_path, worktree_id, status, last_activity_at
		FROM infra.connections
		WHERE tenant_id = $1 AND dev_server_id = $2 AND status <> 'closed'
		ORDER BY created_at DESC
		LIMIT 1
	`, tenantID, devServerID)

	var conn domain.Connection
	err := row.Scan(&conn.ID, &conn.TenantID, &conn.DevServerID, &conn.RepoPath, &conn.WorktreeID, &conn.Status, &conn.LastActivityAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Connection{}, false, nil
	}
	if err != nil {
		return domain.Connection{}, false, fmt.Errorf("postgres: get active connection by dev server: %w", err)
	}
	return conn, true, nil
}

// UpdateStatus persists a connection's Status/DegradedSince after a domain
// state machine transition (BE-SOL-STORAGE-003 §2, TASK-BE-STORAGE-009) —
// scoped by tenant_id like every other mutation in this service.
func (r *Repository) UpdateStatus(ctx context.Context, tenantID string, conn domain.Connection) error {
	tag, err := r.pool.Exec(ctx, `
		UPDATE infra.connections
		SET status = $1, degraded_since = $2
		WHERE id = $3 AND tenant_id = $4
	`, conn.Status, conn.DegradedSince, conn.ID, tenantID)
	if err != nil {
		return fmt.Errorf("postgres: update connection status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: update connection status: no connection %s for tenant %s", conn.ID, tenantID)
	}
	return nil
}

// ListConnectivitySummary returns every connection scoped to tenantID,
// joined through dev_servers as defense-in-depth tenant scoping — backs
// GetFleetConnectivitySummary (TASK-BE-STORAGE-006, CR-STORAGE-007).
func (r *Repository) ListConnectivitySummary(ctx context.Context, tenantID string) ([]domain.Connection, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT c.id, c.tenant_id, c.dev_server_id, c.repo_path, c.worktree_id, c.status,
		       c.last_activity_at, c.degraded_since, c.grace_period_seconds
		FROM infra.connections c
		JOIN infra.dev_servers d ON d.id = c.dev_server_id AND d.tenant_id = c.tenant_id
		WHERE c.tenant_id = $1
		ORDER BY c.created_at DESC
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: list connectivity summary: %w", err)
	}
	defer rows.Close()

	var out []domain.Connection
	for rows.Next() {
		var conn domain.Connection
		if err := rows.Scan(&conn.ID, &conn.TenantID, &conn.DevServerID, &conn.RepoPath, &conn.WorktreeID,
			&conn.Status, &conn.LastActivityAt, &conn.DegradedSince, &conn.GracePeriodSeconds); err != nil {
			return nil, fmt.Errorf("postgres: scan connectivity summary row: %w", err)
		}
		out = append(out, conn)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate connectivity summary rows: %w", err)
	}
	return out, nil
}

// FindBySshTarget returns the DevServer bound to sshTargetID, if any.
func (r *Repository) FindBySshTarget(ctx context.Context, tenantID, sshTargetID string) (domain.DevServer, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind
		FROM infra.dev_servers
		WHERE tenant_id = $1 AND ssh_target_id = $2
		LIMIT 1
	`, tenantID, sshTargetID)

	var ds domain.DevServer
	var mode, status, kind string
	var groupID *string
	err := row.Scan(&ds.ID, &ds.TenantID, &ds.Host, &mode, &ds.SSHTargetID, &status, &groupID, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DevServer{}, false, nil
	}
	if err != nil {
		return domain.DevServer{}, false, fmt.Errorf("postgres: find dev server by ssh target: %w", err)
	}
	ds.Mode = domain.ConnectionMode(mode)
	ds.Status = domain.DevServerStatus(status)
	ds.Kind = domain.AgentKind(kind)
	if groupID != nil {
		ds.GroupID = *groupID
	}
	return ds, true, nil
}

// FindByHostAndMode — live bug found investigating "why does every dev
// server show disconnected despite a genuinely live, handshaked agent":
// this scanned ssh_target_id directly into ds.SSHTargetID (a plain string
// field), which pgx cannot do for a SQL NULL — and ssh_target_id IS NULL
// for every direct-websocket dev server by design (that column only
// applies to relay-ssh mode). So this call ALWAYS errored for the exact
// mode ResolveDirectWebSocketDevServer resolves on every agent-token mint,
// which made that resolver silently fall back to the raw external
// devServerID string (e.g. "dev-01") as the Registry.Register slot key —
// instead of the real domain.DevServer.ID (UUID) that
// ListDevServers/IsDevServerConnected look sessions up by (see
// resolveDirectWebSocketDevServer's fallback comment and
// TokenIssuer.handlePost's same "must not break token issuance" comment).
// AttachInboundSession then stored every live session under that raw
// string key, forever invisible to any UUID-keyed lookup — the agent was
// correctly connected and handshaked the entire time. Fixed by scanning
// through a nullable local var, the same pattern Get/List already use.
func (r *Repository) FindByHostAndMode(ctx context.Context, tenantID, host string, mode domain.ConnectionMode) (domain.DevServer, bool, error) {
	row := r.pool.QueryRow(ctx, `
		SELECT id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind
		FROM infra.dev_servers
		WHERE tenant_id = $1 AND host = $2 AND connection_mode = $3
		LIMIT 1
	`, tenantID, host, string(mode))

	var ds domain.DevServer
	var modeStr, status, kind string
	var sshTargetID, groupID *string
	err := row.Scan(&ds.ID, &ds.TenantID, &ds.Host, &modeStr, &sshTargetID, &status, &groupID, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DevServer{}, false, nil
	}
	if err != nil {
		return domain.DevServer{}, false, fmt.Errorf("postgres: find dev server by host and mode: %w", err)
	}
	if sshTargetID != nil {
		ds.SSHTargetID = *sshTargetID
	}
	ds.Mode = domain.ConnectionMode(modeStr)
	ds.Status = domain.DevServerStatus(status)
	ds.Kind = domain.AgentKind(kind)
	if groupID != nil {
		ds.GroupID = *groupID
	}
	return ds, true, nil
}

// GetFleetHealth returns the latest fleet-health sample per dev server for
// tenantID, joined through dev_servers since fleet_health has no tenant_id
// column of its own (see migrations/0001_init.up.sql's comment on that
// design choice, matching specs/backend-go/services/infra-fleet-service.md
// §5's note on inheriting tenant scope transitively via FK + join).
func (r *Repository) GetFleetHealth(ctx context.Context, tenantID string) ([]domain.DevServerHealth, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT fh.dev_server_id, fh.reachable, fh.cpu_percent, fh.ram_percent, fh.disk_percent, fh.latency_ms
		FROM infra.fleet_health fh
		JOIN infra.dev_servers ds ON ds.id = fh.dev_server_id
		WHERE ds.tenant_id = $1
		ORDER BY fh.checked_at DESC
	`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query fleet health: %w", err)
	}
	defer rows.Close()

	var out []domain.DevServerHealth
	for rows.Next() {
		var h domain.DevServerHealth
		if err := rows.Scan(&h.DevServerID, &h.Reachable, &h.CPUPercent, &h.RAMPercent, &h.DiskPercent, &h.LatencyMS); err != nil {
			return nil, fmt.Errorf("postgres: scan fleet health row: %w", err)
		}
		out = append(out, h)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate fleet health rows: %w", err)
	}
	return out, nil
}

// ListAllDevServers returns every registered dev server across every
// tenant — deliberately unscoped, unlike List/Get/GetFleetHealth. The one
// caller (the fleet-health poller, usecase.PollFleetHealth) is an internal
// background process with no request-scoped tenant to join through, and
// polling reachability is not tenant-sensitive data exposure the way a
// user-facing RPC's response would be.
func (r *Repository) ListAllDevServers(ctx context.Context) ([]domain.DevServer, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, host, connection_mode, ssh_target_id, approval_status, group_id, kind
		FROM infra.dev_servers
	`)
	if err != nil {
		return nil, fmt.Errorf("postgres: query all dev servers: %w", err)
	}
	defer rows.Close()

	var out []domain.DevServer
	for rows.Next() {
		var ds domain.DevServer
		var mode, status, kind string
		var sshTargetID, groupID *string
		if err := rows.Scan(&ds.ID, &ds.TenantID, &ds.Host, &mode, &sshTargetID, &status, &groupID, &kind); err != nil {
			return nil, fmt.Errorf("postgres: scan dev server row: %w", err)
		}
		ds.Mode = domain.ConnectionMode(mode)
		ds.Status = domain.DevServerStatus(status)
		ds.Kind = domain.AgentKind(kind)
		if sshTargetID != nil {
			ds.SSHTargetID = *sshTargetID
		}
		if groupID != nil {
			ds.GroupID = *groupID
		}
		out = append(out, ds)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate all dev server rows: %w", err)
	}
	return out, nil
}

// UpsertFleetHealth writes one dev server's latest health sample —
// infra.fleet_health's primary key is dev_server_id alone (one row per dev
// server, not a history table, see migrations/0001_init.up.sql), so every
// poll replaces the previous sample rather than accumulating rows.
//
// status is derived from reachable alone (healthy/unreachable) — this
// poller only ever measures agent-handshake reachability
// (DevServerAgentClient.Health), not real CPU/RAM/disk thresholds, so
// 'degraded'/'unhealthy' are never produced yet; see PollFleetHealth's own
// doc comment for that scope cut.
func (r *Repository) UpsertFleetHealth(ctx context.Context, h domain.DevServerHealth) error {
	status := "unreachable"
	if h.Reachable {
		status = "healthy"
	}
	_, err := r.pool.Exec(ctx, `
		INSERT INTO infra.fleet_health (dev_server_id, reachable, cpu_percent, ram_percent, disk_percent, latency_ms, checked_at, status)
		VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
		ON CONFLICT (dev_server_id) DO UPDATE SET
			reachable    = EXCLUDED.reachable,
			cpu_percent  = EXCLUDED.cpu_percent,
			ram_percent  = EXCLUDED.ram_percent,
			disk_percent = EXCLUDED.disk_percent,
			latency_ms   = EXCLUDED.latency_ms,
			checked_at   = EXCLUDED.checked_at,
			status       = EXCLUDED.status
	`, h.DevServerID, h.Reachable, h.CPUPercent, h.RAMPercent, h.DiskPercent, h.LatencyMS, status)
	if err != nil {
		return fmt.Errorf("postgres: upsert fleet health: %w", err)
	}
	return nil
}

// GetDevServerHealth returns devServerID's current (about-to-be-overwritten)
// sample — PollFleetHealth's transition-detection read, called BEFORE
// UpsertFleetHealth. found=false (not an error) when no sample exists yet,
// e.g. this dev server's very first poll.
func (r *Repository) GetDevServerHealth(ctx context.Context, devServerID string) (domain.DevServerHealth, bool, error) {
	var h domain.DevServerHealth
	err := r.pool.QueryRow(ctx, `
		SELECT dev_server_id, reachable, cpu_percent, ram_percent, disk_percent, latency_ms
		FROM infra.fleet_health
		WHERE dev_server_id = $1
	`, devServerID).Scan(&h.DevServerID, &h.Reachable, &h.CPUPercent, &h.RAMPercent, &h.DiskPercent, &h.LatencyMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DevServerHealth{}, false, nil
	}
	if err != nil {
		return domain.DevServerHealth{}, false, fmt.Errorf("postgres: query dev server health: %w", err)
	}
	return h, true, nil
}

// InsertOutboxEvent enqueues one row for common/outbox.Relay to publish —
// implements usecase.OutboxWriter against infra.outbox_events
// (migrations/0012_outbox_events).
func (r *Repository) InsertOutboxEvent(ctx context.Context, event domain.OutboxEvent) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO infra.outbox_events (id, tenant_id, subject, occurred_at, version, payload)
		VALUES ($1, $2, $3, $4, 1, $5)
	`, event.ID, event.TenantID, event.Subject, event.OccurredAt, event.PayloadJSON)
	if err != nil {
		return fmt.Errorf("postgres: insert outbox event: %w", err)
	}
	return nil
}

// FetchUnpublished and MarkPublished implement common/outbox.Store — see
// cmd/server/main.go for where the relay is wired, mirroring usage-service's
// identical pattern (that service's own repository.go carries the same doc
// comment on its own copies of these two methods).
func (r *Repository) FetchUnpublished(ctx context.Context, limit int) ([]outbox.Record, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT id, tenant_id, subject, occurred_at, version, payload
		FROM infra.outbox_events
		WHERE published_at IS NULL
		ORDER BY created_at
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("postgres: query unpublished outbox events: %w", err)
	}
	defer rows.Close()

	var out []outbox.Record
	for rows.Next() {
		var rec outbox.Record
		if err := rows.Scan(&rec.ID, &rec.Event.TenantID, &rec.Subject, &rec.Event.OccurredAt, &rec.Event.Version, &rec.Event.Payload); err != nil {
			return nil, fmt.Errorf("postgres: scan outbox event row: %w", err)
		}
		rec.Event.ID = rec.ID
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate outbox event rows: %w", err)
	}
	return out, nil
}

func (r *Repository) MarkPublished(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := r.pool.Exec(ctx, `
		UPDATE infra.outbox_events SET published_at = now() WHERE id = ANY($1)
	`, ids)
	if err != nil {
		return fmt.Errorf("postgres: mark outbox events published: %w", err)
	}
	return nil
}
