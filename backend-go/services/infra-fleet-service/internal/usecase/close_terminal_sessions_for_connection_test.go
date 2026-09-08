package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// TestCloseExplicitly_ClosesAllTerminalSessionsForConnection is
// TASK-BE-STORAGE-010's coverage of BE-SOL-STORAGE-003 §5's "đóng chủ động"
// path: once domain.Connection.CloseExplicitly has transitioned a
// connection straight to closed (bypassing the grace period), every open
// terminal_sessions row bound to it must close too — the same
// CloseTerminalSessionsForConnection usecase CloseAfterGracePeriodExpiry's
// path uses (see poll_fleet_health.go's closeTerminalSessions).
//
// NOTE: no RPC/usecase in this service calls domain.Connection.CloseExplicitly
// yet (no TeardownConnection RPC exists in infrafleet.proto today, despite
// BE-SOL-STORAGE-003 §5 describing one as already in the API surface) — see
// this task's report for that separate, out-of-scope gap. This test proves
// the closing usecase itself behaves correctly for whenever that wiring is
// added, exercised the same way poll_fleet_health.go already exercises it
// for the grace-period-expiry path.
func TestCloseExplicitly_ClosesAllTerminalSessionsForConnection(t *testing.T) {
	conn := domain.Connection{
		ID: "conn-1", TenantID: "tenant-1", DevServerID: "ds-1",
		Status: domain.ConnectionStatusEstablished,
	}
	conn.CloseExplicitly()
	if conn.Status != domain.ConnectionStatusClosed {
		t.Fatalf("precondition failed: want connection closed, got %q", conn.Status)
	}

	sessions := &fakeTerminalSessionRepository{
		byPtyID: map[string]domain.TerminalSession{
			"pty-1": {PtyID: "pty-1", TenantID: "tenant-1", ConnectionID: "conn-1"},
			"pty-2": {PtyID: "pty-2", TenantID: "tenant-1", ConnectionID: "conn-1"},
			// a session on a DIFFERENT connection must be left untouched.
			"pty-other": {PtyID: "pty-other", TenantID: "tenant-1", ConnectionID: "conn-other"},
		},
	}

	uc := NewCloseTerminalSessionsForConnection(sessions)
	if err := uc.Execute(context.Background(), conn.TenantID, conn.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if s := sessions.byPtyID["pty-1"]; s.ClosedAt == nil {
		t.Error("want pty-1 closed")
	}
	if s := sessions.byPtyID["pty-2"]; s.ClosedAt == nil {
		t.Error("want pty-2 closed")
	}
	if s := sessions.byPtyID["pty-other"]; s.ClosedAt != nil {
		t.Error("want pty-other (a different connection) left untouched")
	}
}

// TestCloseTerminalSessionsForConnection_PropagatesRepositoryFailure proves
// a repository error isn't silently swallowed by the usecase itself (the
// caller — poll_fleet_health.go's closeTerminalSessions — is the one that
// decides to only log it).
func TestCloseTerminalSessionsForConnection_PropagatesRepositoryFailure(t *testing.T) {
	sessions := &fakeTerminalSessionRepository{closeAllErr: errors.New("db down")}
	uc := NewCloseTerminalSessionsForConnection(sessions)
	if err := uc.Execute(context.Background(), "tenant-1", "conn-1"); err == nil {
		t.Fatal("expected the repository failure to propagate")
	}
}
