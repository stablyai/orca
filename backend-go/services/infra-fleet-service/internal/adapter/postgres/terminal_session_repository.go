package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// TerminalSessionStore implements usecase.TerminalSessionRepository against
// infra.terminal_sessions (migrations/0005_terminal_sessions) — split into
// its own type over the same pool rather than a method on Repository, same
// rationale as SshTargetStore (see Repository's doc comment): this table
// has its own natural key shape (pty_id, a TEXT id assigned by the agent,
// not a UUID this service generates).
type TerminalSessionStore struct {
	pool *pgxpool.Pool
}

func NewTerminalSessionStore(pool *pgxpool.Pool) *TerminalSessionStore {
	return &TerminalSessionStore{pool: pool}
}

// Create inserts a new terminal session row. connection_id is stored as
// NULL when empty (host-local sessions — see domain.TerminalSession's doc
// comment), mirroring Repository.Register's NULLIF(...)::uuid pattern for
// ssh_target_id.
func (s *TerminalSessionStore) Create(ctx context.Context, session domain.TerminalSession) (domain.TerminalSession, error) {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO infra.terminal_sessions (pty_id, tenant_id, connection_id, cwd, created_at, last_active_at)
		VALUES ($1, $2, NULLIF($3, '')::uuid, $4, $5, $6)
	`, session.PtyID, session.TenantID, session.ConnectionID, session.Cwd, session.CreatedAt, session.LastActiveAt)
	if err != nil {
		return domain.TerminalSession{}, fmt.Errorf("postgres: insert terminal session: %w", err)
	}
	return session, nil
}

// Get fetches one session scoped to tenantID — found=false (not an error)
// when no row matches, per usecase.TerminalSessionRepository's doc comment.
func (s *TerminalSessionStore) Get(ctx context.Context, tenantID, ptyID string) (bool, domain.TerminalSession, error) {
	row := s.pool.QueryRow(ctx, `
		SELECT pty_id, tenant_id, connection_id, cwd, created_at, last_active_at, closed_at
		FROM infra.terminal_sessions
		WHERE tenant_id = $1 AND pty_id = $2
	`, tenantID, ptyID)

	session, err := scanTerminalSession(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, domain.TerminalSession{}, nil
	}
	if err != nil {
		return false, domain.TerminalSession{}, fmt.Errorf("postgres: query terminal session: %w", err)
	}
	return true, session, nil
}

// List returns every OPEN session for tenantID, optionally narrowed to
// connectionID.
func (s *TerminalSessionStore) List(ctx context.Context, tenantID, connectionID string) ([]domain.TerminalSession, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT pty_id, tenant_id, connection_id, cwd, created_at, last_active_at, closed_at
		FROM infra.terminal_sessions
		WHERE tenant_id = $1
		  AND closed_at IS NULL
		  AND ($2 = '' OR connection_id = $2::uuid)
		ORDER BY created_at DESC
	`, tenantID, connectionID)
	if err != nil {
		return nil, fmt.Errorf("postgres: query terminal sessions: %w", err)
	}
	defer rows.Close()

	var out []domain.TerminalSession
	for rows.Next() {
		session, err := scanTerminalSession(rows)
		if err != nil {
			return nil, fmt.Errorf("postgres: scan terminal session row: %w", err)
		}
		out = append(out, session)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("postgres: iterate terminal session rows: %w", err)
	}
	return out, nil
}

// Touch bumps last_active_at for one session scoped to tenantID.
func (s *TerminalSessionStore) Touch(ctx context.Context, tenantID, ptyID string, now time.Time) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE infra.terminal_sessions SET last_active_at = $3
		WHERE tenant_id = $1 AND pty_id = $2
	`, tenantID, ptyID, now)
	if err != nil {
		return fmt.Errorf("postgres: touch terminal session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: terminal session %q not found for tenant", ptyID)
	}
	return nil
}

// Close sets closed_at for one session scoped to tenantID — idempotent, see
// usecase.TerminalSessionRepository.Close's doc comment.
func (s *TerminalSessionStore) Close(ctx context.Context, tenantID, ptyID string, closedAt time.Time) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE infra.terminal_sessions SET closed_at = $3
		WHERE tenant_id = $1 AND pty_id = $2
	`, tenantID, ptyID, closedAt)
	if err != nil {
		return fmt.Errorf("postgres: close terminal session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("postgres: terminal session %q not found for tenant", ptyID)
	}
	return nil
}

// CloseAllForConnection sets closed_at for every OPEN session bound to
// connectionID — BE-SOL-STORAGE-003 §3/TASK-BE-STORAGE-010: called only once
// connections.status has genuinely transitioned to closed (grace-period
// expiry or explicit teardown), never for a merely degraded connection.
// Zero matching rows is not an error — a connection with no open terminal
// sessions is a normal, expected case.
func (s *TerminalSessionStore) CloseAllForConnection(ctx context.Context, tenantID, connectionID string, closedAt time.Time) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE infra.terminal_sessions
		SET closed_at = $3
		WHERE tenant_id = $1 AND connection_id = $2::uuid AND closed_at IS NULL
	`, tenantID, connectionID, closedAt)
	if err != nil {
		return fmt.Errorf("postgres: close all terminal sessions for connection: %w", err)
	}
	return nil
}

// rowScanner abstracts over pgx.Row/pgx.Rows — both expose Scan(...any) error,
// letting Get and List share one column-order-sensitive scan function
// instead of duplicating it.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanTerminalSession(row rowScanner) (domain.TerminalSession, error) {
	var session domain.TerminalSession
	var connectionID *string
	var closedAt *time.Time
	err := row.Scan(&session.PtyID, &session.TenantID, &connectionID, &session.Cwd, &session.CreatedAt, &session.LastActiveAt, &closedAt)
	if err != nil {
		return domain.TerminalSession{}, err
	}
	if connectionID != nil {
		session.ConnectionID = *connectionID
	}
	session.ClosedAt = closedAt
	return session, nil
}
