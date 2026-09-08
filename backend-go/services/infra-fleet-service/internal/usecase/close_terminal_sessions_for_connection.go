package usecase

import (
	"context"
	"time"
)

// CloseTerminalSessionsForConnection closes every terminal_sessions row
// bound to one connectionId — the "(b) connections.status chuyển sang
// closed" half of BE-SOL-STORAGE-003 §3's closed_at rule
// (TASK-BE-STORAGE-010). It must only ever be called from the two
// transitions that actually reach connections.status = 'closed':
// domain.Connection.CloseAfterGracePeriodExpiry (grace period expiry —
// wired into PollFleetHealth.reestablishConnection) or
// domain.Connection.CloseExplicitly (confirmed logout / TeardownConnection,
// not yet wired to any RPC in this service — see this task's report).
//
// NEVER call this from domain.Connection.MarkDegraded: a merely degraded
// connection keeps its terminal sessions open so the agent can reattach
// (WaitTerminalSession/FocusTerminalSession, BE-SOL-STORAGE-003 §3) if it
// reconnects within the grace period.
type CloseTerminalSessionsForConnection struct {
	sessions TerminalSessionRepository
}

func NewCloseTerminalSessionsForConnection(sessions TerminalSessionRepository) *CloseTerminalSessionsForConnection {
	return &CloseTerminalSessionsForConnection{sessions: sessions}
}

// Execute closes every open terminal session for connectionID within
// tenantID's scope. Idempotent: a connection with no open sessions (or only
// already-closed ones) closes zero rows, not an error.
func (uc *CloseTerminalSessionsForConnection) Execute(ctx context.Context, tenantID, connectionID string) error {
	return uc.sessions.CloseAllForConnection(ctx, tenantID, connectionID, time.Now().UTC())
}
