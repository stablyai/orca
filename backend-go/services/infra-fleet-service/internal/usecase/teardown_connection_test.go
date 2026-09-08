package usecase

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// TestExplicitTeardownBypassesGracePeriod is TASK-BE-STORAGE-012's core
// regression: a degraded connection whose grace_period_seconds is nowhere
// near expiring must still close immediately when TeardownConnection is
// called — BE-SOL-STORAGE-003 §5's "bỏ qua grace-period" rule, the one
// deliberate difference from an unplanned disconnect.
func TestExplicitTeardownBypassesGracePeriod(t *testing.T) {
	degradedAt := time.Now().Add(-1 * time.Second) // grace period (300s default) nowhere near expiring
	conn := domain.Connection{
		ID: "conn-1", TenantID: "tenant-1", DevServerID: "ds-1",
		Status: domain.ConnectionStatusDegraded, DegradedSince: &degradedAt, GracePeriodSeconds: 300,
	}
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": {ID: "ds-1", TenantID: "tenant-1"}},
		connByID:       map[string]domain.Connection{"conn-1": conn},
	}
	conns := &fakeConnectionRepository{}
	sessions := &fakeTerminalSessionRepository{}

	uc := NewTeardownConnection(resolver, conns, sessions, &fakeDevServerAgentClient{})
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	if err := uc.Execute(ctx, "conn-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(conns.updated) != 1 {
		t.Fatalf("want 1 connection status update, got %d", len(conns.updated))
	}
	got := conns.updated[0]
	if got.Status != domain.ConnectionStatusClosed {
		t.Errorf("got status %q, want %q", got.Status, domain.ConnectionStatusClosed)
	}
	if got.DegradedSince != nil {
		t.Error("expected DegradedSince to be cleared")
	}
}

// TestTeardownConnection_ClosesTerminalSessions proves the composition with
// CloseTerminalSessionsForConnection (TASK-BE-STORAGE-010): every open
// terminal session bound to the torn-down connection must be closed too,
// and a session on a different connection must be left untouched.
func TestTeardownConnection_ClosesTerminalSessions(t *testing.T) {
	conn := domain.Connection{ID: "conn-1", TenantID: "tenant-1", DevServerID: "ds-1", Status: domain.ConnectionStatusEstablished}
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": {ID: "ds-1", TenantID: "tenant-1"}},
		connByID:       map[string]domain.Connection{"conn-1": conn},
	}
	conns := &fakeConnectionRepository{}
	sessions := &fakeTerminalSessionRepository{
		byPtyID: map[string]domain.TerminalSession{
			"pty-1":     {PtyID: "pty-1", TenantID: "tenant-1", ConnectionID: "conn-1"},
			"pty-2":     {PtyID: "pty-2", TenantID: "tenant-1", ConnectionID: "conn-1"},
			"pty-other": {PtyID: "pty-other", TenantID: "tenant-1", ConnectionID: "conn-other"},
		},
	}

	uc := NewTeardownConnection(resolver, conns, sessions, &fakeDevServerAgentClient{})
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	if err := uc.Execute(ctx, "conn-1"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if len(sessions.closeAllCalls) != 1 || sessions.closeAllCalls[0] != "conn-1" {
		t.Fatalf("want CloseAllForConnection called once with %q, got %v", "conn-1", sessions.closeAllCalls)
	}
	if s := sessions.byPtyID["pty-1"]; s.ClosedAt == nil {
		t.Error("want pty-1 closed after teardown")
	}
	if s := sessions.byPtyID["pty-2"]; s.ClosedAt == nil {
		t.Error("want pty-2 closed after teardown")
	}
	if s := sessions.byPtyID["pty-other"]; s.ClosedAt != nil {
		t.Error("want pty-other (a different connection) left untouched")
	}
}

// TestTeardownConnection_RequiresTenantContext mirrors every other
// usecase's "no tenant in ctx" guard (see TestCreateConnection_RequiresTenantContext).
func TestTeardownConnection_RequiresTenantContext(t *testing.T) {
	uc := NewTeardownConnection(&fakeConnectionResolver{}, &fakeConnectionRepository{}, &fakeTerminalSessionRepository{}, &fakeDevServerAgentClient{})
	err := uc.Execute(context.Background(), "conn-1")
	if err == nil {
		t.Fatal("expected an error with no tenant in context")
	}
}

// TestTeardownConnection_UnknownConnection_ReturnsNotFound asserts an
// explicit teardown request naming a connectionId unknown to this tenant is
// a not-found error, not a silent no-op — unlike ResolveConnection's
// "not found = execute locally" convention for a dispatch lookup.
func TestTeardownConnection_UnknownConnection_ReturnsNotFound(t *testing.T) {
	uc := NewTeardownConnection(&fakeConnectionResolver{}, &fakeConnectionRepository{}, &fakeTerminalSessionRepository{}, &fakeDevServerAgentClient{})
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	err := uc.Execute(ctx, "conn-missing")

	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindNotFound {
		t.Fatalf("expected KindNotFound, got %v", err)
	}
}

// TestTeardownConnection_AlreadyClosed_IsIdempotent proves calling teardown
// twice (e.g. a retried logout request) never errors — CloseExplicitly is
// itself idempotent from an already-closed status.
func TestTeardownConnection_AlreadyClosed_IsIdempotent(t *testing.T) {
	conn := domain.Connection{ID: "conn-1", TenantID: "tenant-1", DevServerID: "ds-1", Status: domain.ConnectionStatusClosed}
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": {ID: "ds-1", TenantID: "tenant-1"}},
		connByID:       map[string]domain.Connection{"conn-1": conn},
	}
	conns := &fakeConnectionRepository{}
	sessions := &fakeTerminalSessionRepository{}

	uc := NewTeardownConnection(resolver, conns, sessions, &fakeDevServerAgentClient{})
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	if err := uc.Execute(ctx, "conn-1"); err != nil {
		t.Fatalf("unexpected error tearing down an already-closed connection: %v", err)
	}
	if got := conns.updated[0].Status; got != domain.ConnectionStatusClosed {
		t.Errorf("got status %q, want %q", got, domain.ConnectionStatusClosed)
	}
}

// TestTeardownConnection_NotifiesAgentBestEffort confirms Execute calls the
// agent's connection.teardown method (TASK-AG-STORAGE-007's inbound side)
// after the DB-side close succeeds, and that an unreachable/erroring agent
// does NOT fail the teardown — the deliberate best-effort choice documented
// on Execute's own notify call, distinct from KillWorkspacePort's
// propagate-the-agent-error pattern.
func TestTeardownConnection_NotifiesAgentBestEffort(t *testing.T) {
	conn := domain.Connection{ID: "conn-1", TenantID: "tenant-1", DevServerID: "ds-1", Status: domain.ConnectionStatusEstablished}
	resolver := &fakeConnectionResolver{
		byConnectionID: map[string]domain.DevServer{"conn-1": {ID: "ds-1", TenantID: "tenant-1"}},
		connByID:       map[string]domain.Connection{"conn-1": conn},
	}
	agent := &fakeDevServerAgentClient{execErr: errors.New("dev server unreachable")}

	uc := NewTeardownConnection(resolver, &fakeConnectionRepository{}, &fakeTerminalSessionRepository{}, agent)
	ctx := tenant.WithTenantID(context.Background(), "tenant-1")
	if err := uc.Execute(ctx, "conn-1"); err != nil {
		t.Fatalf("want teardown to succeed even when agent notify fails, got: %v", err)
	}

	if !agent.execCalled {
		t.Fatal("want agent.Exec called for connection.teardown notify")
	}
	if agent.lastMethod != "connection.teardown" {
		t.Errorf("want method %q, got %q", "connection.teardown", agent.lastMethod)
	}
}
