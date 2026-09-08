package domain

import (
	"errors"
	"fmt"
	"time"
)

var (
	// ErrEmptyConnectionTenant mirrors ErrEmptyDevServerTenant — a connection
	// with no owning tenant is never a valid domain state.
	ErrEmptyConnectionTenant = errors.New("domain: tenant_id is required")
	// ErrEmptyConnectionDevServer guards against a connection that doesn't
	// point at any dev server — the whole point of the entity.
	ErrEmptyConnectionDevServer = errors.New("domain: dev_server_id is required")
	// ErrGracePeriodExpired is returned by Reestablish when now is past
	// DegradedSince+GracePeriodSeconds — the caller must call
	// CloseAfterGracePeriodExpiry instead (BE-SOL-STORAGE-003 §2), never
	// silently reopen a connection that already timed out.
	ErrGracePeriodExpired = errors.New("domain: grace period has expired, cannot reestablish")
	// ErrGracePeriodNotYetExpired is returned by CloseAfterGracePeriodExpiry
	// when called too early — closing before the grace period elapses would
	// orphan an in-progress reconnect attempt.
	ErrGracePeriodNotYetExpired = errors.New("domain: grace period has not yet expired")
)

// Connection status values — mirrors the CHECK constraint on
// infra.connections.status (migrations/0004_connection_status,
// specs/backend-go/services/infra-fleet-service.md §5). Kept as untyped
// string constants (not a distinct named type) so Connection.Status stays
// a plain string, matching every existing call site that already compares
// it against string literals (e.g. usecase.EstablishConnection).
const (
	ConnectionStatusEstablishing = "establishing"
	ConnectionStatusEstablished  = "established"
	ConnectionStatusDegraded     = "degraded"
	ConnectionStatusClosed       = "closed"
)

// Connection binds a worktree/repo path to the DevServer that owns it — the
// entity ResolveConnection resolves against (see migrations/0002_connections),
// replacing the scaffold's original connectionId==dev_server.id equation.
// See specs/backend-go/services/infra-fleet-service.md §5.
type Connection struct {
	ID          string
	TenantID    string
	DevServerID string
	RepoPath    string
	WorktreeID  string
	// Status/LastActivityAt are set by EstablishConnection (ssh.connect,
	// SOL-024/TASK-164) — empty/nil for connections predating this field
	// (worktree-bound connections created via CreateConnection, not
	// EstablishConnection). See migrations/0004_connection_status.
	Status         string // "establishing" | "established" | "degraded" | "closed"
	LastActivityAt *time.Time
	// DegradedSince/GracePeriodSeconds back the reconnect-resume state
	// machine (BE-SOL-STORAGE-003 §2, migrations/0014_connections_grace_period).
	// DegradedSince is nil unless Status == ConnectionStatusDegraded.
	// GracePeriodSeconds defaults to 300 (see the migration's column
	// default) — how long a connection may stay degraded before
	// CloseAfterGracePeriodExpiry is allowed to close it.
	DegradedSince      *time.Time
	GracePeriodSeconds int
}

// NewConnection constructs a Connection, enforcing the invariants a record
// must satisfy to be meaningful — RepoPath/WorktreeID are intentionally not
// required here: a connection can be registered before either is known and
// filled in later (mirrors DevServer's registration-then-detail pattern).
func NewConnection(id, tenantID, devServerID, repoPath, worktreeID string) (Connection, error) {
	if tenantID == "" {
		return Connection{}, ErrEmptyConnectionTenant
	}
	if devServerID == "" {
		return Connection{}, ErrEmptyConnectionDevServer
	}
	return Connection{ID: id, TenantID: tenantID, DevServerID: devServerID, RepoPath: repoPath, WorktreeID: worktreeID}, nil
}

// IsZero reports whether c is the zero-value Connection.
func (c Connection) IsZero() bool {
	return c == Connection{}
}

// MarkDegraded transitions established -> degraded — called by the
// health-poll usecase when it detects a lost heartbeat/keep-alive, NOT for
// an explicit close (see CloseExplicitly for that path).
// BE-SOL-STORAGE-003 §2: this is the only state a connection may enter
// established from besides closed.
func (c *Connection) MarkDegraded(now time.Time) error {
	if c.Status != ConnectionStatusEstablished {
		return fmt.Errorf("domain: cannot mark degraded from status %q", c.Status)
	}
	c.Status = ConnectionStatusDegraded
	degradedAt := now
	c.DegradedSince = &degradedAt
	return nil
}

// Reestablish transitions degraded -> established when the agent reconnects
// within the grace period, REUSING this Connection's existing ID (no new
// connection is created) — BE-SOL-STORAGE-003 §2. Returns
// ErrGracePeriodExpired if now is past DegradedSince+GracePeriodSeconds; the
// caller must call CloseAfterGracePeriodExpiry instead in that case, not
// silently reopen an already-timed-out connection.
func (c *Connection) Reestablish(now time.Time) error {
	if c.Status != ConnectionStatusDegraded {
		return fmt.Errorf("domain: cannot reestablish from status %q", c.Status)
	}
	if c.DegradedSince == nil {
		return fmt.Errorf("domain: cannot reestablish, degraded_since is unset")
	}
	if now.Sub(*c.DegradedSince) > time.Duration(c.GracePeriodSeconds)*time.Second {
		return ErrGracePeriodExpired
	}
	c.Status = ConnectionStatusEstablished
	c.DegradedSince = nil
	return nil
}

// CloseAfterGracePeriodExpiry transitions degraded -> closed, but only once
// the grace period has actually elapsed — this is the "hết grace-period mà
// không reconnect được" edge of BE-SOL-STORAGE-003 §2, the real-failure path
// that should trigger FailDispatch downstream (unlike a transient degraded
// state, which must not).
func (c *Connection) CloseAfterGracePeriodExpiry(now time.Time) error {
	if c.Status != ConnectionStatusDegraded {
		return fmt.Errorf("domain: cannot close after grace period from status %q", c.Status)
	}
	if c.DegradedSince == nil {
		return fmt.Errorf("domain: cannot close after grace period, degraded_since is unset")
	}
	if now.Sub(*c.DegradedSince) <= time.Duration(c.GracePeriodSeconds)*time.Second {
		return ErrGracePeriodNotYetExpired
	}
	c.Status = ConnectionStatusClosed
	c.DegradedSince = nil
	return nil
}

// CloseExplicitly transitions any non-closed status straight to closed,
// bypassing the grace period entirely — BE-SOL-STORAGE-003 §5's "đóng chủ
// động" path (confirmed logout, or TeardownConnection called directly).
// This is the one deliberate difference from an unplanned disconnect:
// there is no reconnect window to honor when the user (or an explicit
// admin/API call) asked for the connection to close right now. Idempotent
// when already closed.
func (c *Connection) CloseExplicitly() {
	c.Status = ConnectionStatusClosed
	c.DegradedSince = nil
}
