package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// TestResolveTerminalSession_ConnectionIDIsActuallyADevServerID is the
// "chicken-and-egg" regression this fallback closes for every control-plane
// terminal operation (resize/kill/stop/wait/focus/agentStatus/
// inspectProcess), not just SpawnTerminalSession: a pre-project ephemeral
// terminal (CLI install, agent-skill setup) was spawned with a devServerId
// standing in for ConnectionID (no infra.connections row exists for it), so
// every later operation on that same session's ptyId must resolve the
// stored ConnectionID the identical way, or the terminal breaks the moment
// anything past its initial spawn happens (a resize on mount, in practice).
// Found live 2026-08-30, right after the SpawnTerminalSession fix.
func TestResolveTerminalSession_ConnectionIDIsActuallyADevServerID(t *testing.T) {
	ds, err := domain.NewDevServer("ds-1", "tenant-1", "10.0.0.5", domain.ConnectionModeDirectWebSocket, "")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	sessions := &fakeTerminalSessionRepository{
		byPtyID: map[string]domain.TerminalSession{
			"pty-1": {PtyID: "pty-1", TenantID: "tenant-1", ConnectionID: "ds-1"},
		},
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{byID: map[string]domain.DevServer{"ds-1": ds}}

	session, devServer, err := resolveTerminalSession(withTenant(context.Background(), "tenant-1"), "tenant-1", "pty-1", sessions, resolver, devServers)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if session.PtyID != "pty-1" {
		t.Errorf("expected session PtyID %q, got %q", "pty-1", session.PtyID)
	}
	if devServer.ID != "ds-1" {
		t.Errorf("expected resolved DevServer.ID %q, got %q", "ds-1", devServer.ID)
	}
}

func TestResolveTerminalSession_NeitherConnectionNorDevServerFound_ReturnsNotFound(t *testing.T) {
	sessions := &fakeTerminalSessionRepository{
		byPtyID: map[string]domain.TerminalSession{
			"pty-1": {PtyID: "pty-1", TenantID: "tenant-1", ConnectionID: "unknown-id"},
		},
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{getErr: errors.New("not found")}

	_, _, err := resolveTerminalSession(withTenant(context.Background(), "tenant-1"), "tenant-1", "pty-1", sessions, resolver, devServers)
	if err == nil {
		t.Fatal("expected an error when neither ResolveConnection nor the devServerId fallback finds anything")
	}
}

func TestResolveTerminalSession_EmptyConnectionID_ReturnsNoComputeBound(t *testing.T) {
	sessions := &fakeTerminalSessionRepository{
		byPtyID: map[string]domain.TerminalSession{
			"pty-1": {PtyID: "pty-1", TenantID: "tenant-1", ConnectionID: ""},
		},
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{}

	_, _, err := resolveTerminalSession(withTenant(context.Background(), "tenant-1"), "tenant-1", "pty-1", sessions, resolver, devServers)
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %v", err)
	}
	if appErr.Code != "INFRA_TERMINAL_NO_COMPUTE_BOUND" {
		t.Errorf("expected code INFRA_TERMINAL_NO_COMPUTE_BOUND, got %q", appErr.Code)
	}
}
