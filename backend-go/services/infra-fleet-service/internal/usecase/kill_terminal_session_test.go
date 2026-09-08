package usecase

import (
	"context"
	"testing"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// TestKillTerminalSession_StillWorksIndependentlyOfConnectionStatus is
// TASK-BE-STORAGE-010's regression guard: KillTerminalSession's explicit
// close (path (a) of BE-SOL-STORAGE-003 §3's closed_at rule) must keep
// working exactly the same no matter what internal/domain/connection.go's
// state machine says about the connection the session is bound to —
// degraded, established, it doesn't matter, an explicit terminal.close
// always closes the pty session.
func TestKillTerminalSession_StillWorksIndependentlyOfConnectionStatus(t *testing.T) {
	for _, status := range []string{
		domain.ConnectionStatusEstablished,
		domain.ConnectionStatusDegraded,
		domain.ConnectionStatusClosed,
	} {
		t.Run(status, func(t *testing.T) {
			ds, err := domain.NewDevServer("ds-1", "tenant-1", "10.0.0.5", domain.ConnectionModeDirectWebSocket, "")
			if err != nil {
				t.Fatalf("building dev server: %v", err)
			}
			sessions := &fakeTerminalSessionRepository{
				byPtyID: map[string]domain.TerminalSession{
					"pty-1": {PtyID: "pty-1", TenantID: "tenant-1", ConnectionID: "conn-1"},
				},
			}
			resolver := &fakeConnectionResolver{
				byConnectionID: map[string]domain.DevServer{"conn-1": ds},
				connByID:       map[string]domain.Connection{"conn-1": {ID: "conn-1", TenantID: "tenant-1", Status: status}},
			}
			devServers := &fakeDevServerRepository{byID: map[string]domain.DevServer{"ds-1": ds}}
			agent := &fakeDevServerAgentClient{}

			uc := NewKillTerminalSession(sessions, resolver, devServers, agent)
			ctx := withTenant(context.Background(), "tenant-1")
			if err := uc.Execute(ctx, "pty-1"); err != nil {
				t.Fatalf("unexpected error for connection status %q: %v", status, err)
			}

			if len(sessions.closeCalls) != 1 || sessions.closeCalls[0] != "pty-1" {
				t.Fatalf("want Close called once with pty-1, got %v", sessions.closeCalls)
			}
			s := sessions.byPtyID["pty-1"]
			if s.ClosedAt == nil {
				t.Errorf("want terminal session closed regardless of connection status %q", status)
			}
			if len(agent.killPtyCalls) != 1 || agent.killPtyCalls[0] != "pty-1" {
				t.Fatalf("want KillPty called once with pty-1, got %v", agent.killPtyCalls)
			}
		})
	}
}
