package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

func TestSpawnTerminalSession_RequiresTenantContext(t *testing.T) {
	uc := NewSpawnTerminalSession(&fakeConnectionResolver{}, &fakeDevServerRepository{}, &fakeDevServerAgentClient{}, &fakeTerminalSessionRepository{}, &fakeEphemeralVmRuntimeRepository{}, false)
	_, err := uc.Execute(context.Background(), SpawnTerminalSessionInput{ConnectionID: "conn-1"})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestSpawnTerminalSession_HostLocal_RejectedInServerDeploymentMode(t *testing.T) {
	uc := NewSpawnTerminalSession(&fakeConnectionResolver{}, &fakeDevServerRepository{}, &fakeDevServerAgentClient{}, &fakeTerminalSessionRepository{}, &fakeEphemeralVmRuntimeRepository{}, true)
	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, SpawnTerminalSessionInput{})
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %v", err)
	}
	if appErr.Code != "INFRA_TERMINAL_HOST_LOCAL_DISABLED" {
		t.Errorf("expected code INFRA_TERMINAL_HOST_LOCAL_DISABLED, got %q", appErr.Code)
	}
}

func TestSpawnTerminalSession_NoComputeBound_OutsideServerDeploymentMode(t *testing.T) {
	uc := NewSpawnTerminalSession(&fakeConnectionResolver{}, &fakeDevServerRepository{}, &fakeDevServerAgentClient{}, &fakeTerminalSessionRepository{}, &fakeEphemeralVmRuntimeRepository{}, false)
	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, SpawnTerminalSessionInput{})
	var appErr *apperrors.AppError
	if !errors.As(err, &appErr) {
		t.Fatalf("expected an *apperrors.AppError, got %v", err)
	}
	if appErr.Code != "INFRA_TERMINAL_NO_COMPUTE_BOUND" {
		t.Errorf("expected code INFRA_TERMINAL_NO_COMPUTE_BOUND, got %q", appErr.Code)
	}
}

func TestSpawnTerminalSession_UnresolvedConnection_ReturnsNotFoundError(t *testing.T) {
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{getErr: errors.New("not found")}
	agent := &fakeDevServerAgentClient{}
	sessions := &fakeTerminalSessionRepository{}
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, &fakeEphemeralVmRuntimeRepository{}, false)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "unknown-conn"})
	if err == nil {
		t.Fatal("expected an error when the connectionId doesn't resolve as a connection or a devServerId")
	}
	if len(agent.spawnPtyCalls) != 0 {
		t.Error("expected no pty.create call when the connectionId doesn't resolve")
	}
}

func TestSpawnTerminalSession_ResolvedConnection_SpawnsAndPersists(t *testing.T) {
	ds, err := domain.NewDevServer("ds1", "tenant-1", "10.0.0.5", domain.ConnectionModeRelayWebSocket, "")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{"conn-1": ds}}
	devServers := &fakeDevServerRepository{}
	agent := &fakeDevServerAgentClient{spawnPtyResult: SpawnPtyResult{PtyID: "pty-abc", Cwd: "/work", Cols: 80, Rows: 24, Shell: "/bin/bash"}}
	sessions := &fakeTerminalSessionRepository{}
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, &fakeEphemeralVmRuntimeRepository{}, false)

	ctx := withTenant(context.Background(), "tenant-1")
	session, err := uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "conn-1", Cwd: "/repo", Cols: 80, Rows: 24})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if session.PtyID != "pty-abc" {
		t.Errorf("expected PtyID %q, got %q", "pty-abc", session.PtyID)
	}
	if session.TenantID != "tenant-1" {
		t.Errorf("expected TenantID %q, got %q", "tenant-1", session.TenantID)
	}
	if session.ConnectionID != "conn-1" {
		t.Errorf("expected ConnectionID %q, got %q", "conn-1", session.ConnectionID)
	}
	if session.Cwd != "/work" {
		t.Errorf("expected agent's effective Cwd %q to win, got %q", "/work", session.Cwd)
	}
	if len(sessions.createCalls) != 1 {
		t.Fatalf("expected exactly one Create call, got %d", len(sessions.createCalls))
	}
}

func TestSpawnTerminalSession_AgentFailurePropagates(t *testing.T) {
	ds, err := domain.NewDevServer("ds1", "tenant-1", "10.0.0.5", domain.ConnectionModeRelayWebSocket, "")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{"conn-1": ds}}
	devServers := &fakeDevServerRepository{}
	agent := &fakeDevServerAgentClient{spawnPtyErr: errors.New("devserveragent: not connected")}
	sessions := &fakeTerminalSessionRepository{}
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, &fakeEphemeralVmRuntimeRepository{}, false)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err = uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "conn-1"})
	if err == nil {
		t.Fatal("expected the agent's error to propagate")
	}
	if len(sessions.createCalls) != 0 {
		t.Error("expected no persisted session when the agent call fails")
	}
}

// TestSpawnTerminalSession_ConnectionIDIsActuallyADevServerID_SpawnsAndPersists
// is the "chicken-and-egg" regression this fallback exists to close: a
// pre-project ephemeral terminal (CLI install, agent-skill setup) has no
// infra.connections row to resolve — ResolveConnection correctly reports
// connected=false — but the caller's ConnectionID is genuinely a live,
// connected devServerId, and the spawn must still succeed against it,
// exactly like RelayByDevServer already does for Relay. Found live
// 2026-08-30 on the real onboarding CLI-install terminal.
func TestSpawnTerminalSession_ConnectionIDIsActuallyADevServerID_SpawnsAndPersists(t *testing.T) {
	ds, err := domain.NewDevServer("ds-1", "tenant-1", "10.0.0.5", domain.ConnectionModeDirectWebSocket, "")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{byID: map[string]domain.DevServer{"ds-1": ds}}
	agent := &fakeDevServerAgentClient{
		isConnected:    true,
		spawnPtyResult: SpawnPtyResult{PtyID: "pty-xyz", Cwd: "/home/orca", Cols: 80, Rows: 24},
	}
	sessions := &fakeTerminalSessionRepository{}
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, &fakeEphemeralVmRuntimeRepository{}, false)

	ctx := withTenant(context.Background(), "tenant-1")
	session, err := uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "ds-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if session.PtyID != "pty-xyz" {
		t.Errorf("expected PtyID %q, got %q", "pty-xyz", session.PtyID)
	}
	if len(sessions.createCalls) != 1 {
		t.Fatalf("expected exactly one Create call, got %d", len(sessions.createCalls))
	}
}

func TestSpawnTerminalSession_ConnectionIDIsADevServerIDButNotConnected_ReturnsFailedPrecondition(t *testing.T) {
	ds, err := domain.NewDevServer("ds-1", "tenant-1", "10.0.0.5", domain.ConnectionModeDirectWebSocket, "")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{byID: map[string]domain.DevServer{"ds-1": ds}}
	agent := &fakeDevServerAgentClient{isConnected: false}
	sessions := &fakeTerminalSessionRepository{}
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, &fakeEphemeralVmRuntimeRepository{}, false)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err = uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "ds-1"})
	if err == nil {
		t.Fatal("expected an error when the dev server has no live agent connection")
	}
	if len(agent.spawnPtyCalls) != 0 {
		t.Error("expected no pty.create call when the dev server isn't connected")
	}
	if len(sessions.createCalls) != 0 {
		t.Error("expected no persisted session when the dev server isn't connected")
	}
}

// TestSpawnTerminalSession_ResolvableEnvironmentIdFallsThroughToDevServerIdPath
// covers TASK-BE-EVM-007's 3rd fallback: ConnectionID resolves as neither a
// connections row nor a raw devServerId directly, but IS a known ephemeral
// VM environmentId (environment_id == dev_server_id by design, BE-SOL-EVM-003
// §1) — the spawn must succeed exactly like the direct-devServerId fallback
// does.
func TestSpawnTerminalSession_ResolvableEnvironmentIdFallsThroughToDevServerIdPath(t *testing.T) {
	ds, err := domain.NewDevServer("ds-1", "tenant-1", "10.0.0.5", domain.ConnectionModeDirectWebSocket, "")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{byID: map[string]domain.DevServer{"ds-1": ds}}
	agent := &fakeDevServerAgentClient{
		isConnected:    true,
		spawnPtyResult: SpawnPtyResult{PtyID: "pty-env", Cwd: "/home/orca", Cols: 80, Rows: 24},
	}
	sessions := &fakeTerminalSessionRepository{}
	ephemeralVmRuntimes := &fakeEphemeralVmRuntimeRepository{byEnvironmentID: map[string]string{"env-1": "ds-1"}}
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, ephemeralVmRuntimes, false)

	ctx := withTenant(context.Background(), "tenant-1")
	session, err := uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "env-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if session.PtyID != "pty-env" {
		t.Errorf("expected PtyID %q, got %q", "pty-env", session.PtyID)
	}
	if len(sessions.createCalls) != 1 {
		t.Fatalf("expected exactly one Create call, got %d", len(sessions.createCalls))
	}
}

// TestSpawnTerminalSession_UnresolvableEnvironmentIdReturnsNoComputeBound
// covers the existing behavior for a genuinely unresolvable id — MUST
// still return INFRA_TERMINAL_NO_COMPUTE_BOUND (the pre-TASK-BE-EVM-007
// "this environment has no dev server or SSH connection bound yet" state,
// not a bug), not a raw/opaque error.
func TestSpawnTerminalSession_UnresolvableEnvironmentIdReturnsNoComputeBound(t *testing.T) {
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{getErr: errors.New("not found")}
	agent := &fakeDevServerAgentClient{}
	sessions := &fakeTerminalSessionRepository{}
	ephemeralVmRuntimes := &fakeEphemeralVmRuntimeRepository{} // no environmentId bindings at all
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, ephemeralVmRuntimes, false)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err := uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "env-never-provisioned"})
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition, got %v", err)
	}
	if ae.Code != "INFRA_TERMINAL_NO_COMPUTE_BOUND" {
		t.Errorf("expected INFRA_TERMINAL_NO_COMPUTE_BOUND, got %q", ae.Code)
	}
	if len(agent.spawnPtyCalls) != 0 {
		t.Error("expected no pty.create call when the environmentId doesn't resolve")
	}
}

// TestSpawnTerminalSession_EnvironmentIdScopedByTenant asserts
// FindDevServerByEnvironmentID is called with the CALLER's tenantID — the
// fake's map is deliberately not tenant-namespaced (mirrors the real
// Postgres query's WHERE tenant_id = $1 AND environment_id = $2 scoping,
// which this test can't exercise directly without a real DB, so it asserts
// the usecase always passes tenantID through instead of, say, an empty
// string or a hardcoded value that would silently defeat that scoping).
func TestSpawnTerminalSession_EnvironmentIdScopedByTenant(t *testing.T) {
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	devServers := &fakeDevServerRepository{getErr: errors.New("not found")}
	agent := &fakeDevServerAgentClient{}
	sessions := &fakeTerminalSessionRepository{}
	var gotTenantID string
	ephemeralVmRuntimes := &fakeEphemeralVmRuntimeRepositoryTenantSpy{onFind: func(tenantID, environmentID string) {
		gotTenantID = tenantID
	}}
	uc := NewSpawnTerminalSession(resolver, devServers, agent, sessions, ephemeralVmRuntimes, false)

	ctx := withTenant(context.Background(), "tenant-42")
	_, _ = uc.Execute(ctx, SpawnTerminalSessionInput{ConnectionID: "env-1"})
	if gotTenantID != "tenant-42" {
		t.Errorf("expected FindDevServerByEnvironmentID to be called with tenantID=tenant-42, got %q", gotTenantID)
	}
}

// fakeEphemeralVmRuntimeRepositoryTenantSpy is a minimal
// EphemeralVmRuntimeRepository double just for asserting the tenantID
// FindDevServerByEnvironmentID is called with — kept separate from
// fakeEphemeralVmRuntimeRepository (list_ephemeral_vm_runtimes_test.go) to
// avoid growing that shared fake's already-large field list for a
// single-purpose spy only this test needs.
type fakeEphemeralVmRuntimeRepositoryTenantSpy struct {
	onFind func(tenantID, environmentID string)
}

func (f *fakeEphemeralVmRuntimeRepositoryTenantSpy) List(context.Context, string) ([]domain.EphemeralVmRuntime, error) {
	return nil, nil
}
func (f *fakeEphemeralVmRuntimeRepositoryTenantSpy) Get(context.Context, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
}
func (f *fakeEphemeralVmRuntimeRepositoryTenantSpy) GetByWorkspaceID(context.Context, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
}
func (f *fakeEphemeralVmRuntimeRepositoryTenantSpy) UpdateStatus(context.Context, string, string, string, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeEphemeralVmRuntimeRepositoryTenantSpy) UpdateProvisionResult(context.Context, string, string, string, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, nil
}
func (f *fakeEphemeralVmRuntimeRepositoryTenantSpy) FindDevServerByEnvironmentID(_ context.Context, tenantID, environmentID string) (string, bool, error) {
	f.onFind(tenantID, environmentID)
	return "", false, nil
}
func (f *fakeEphemeralVmRuntimeRepositoryTenantSpy) SetEnvironmentID(context.Context, string, string, string) (domain.EphemeralVmRuntime, error) {
	return domain.EphemeralVmRuntime{}, domain.ErrEphemeralVmRuntimeNotFound
}
