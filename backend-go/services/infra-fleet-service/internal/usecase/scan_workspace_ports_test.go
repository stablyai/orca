package usecase

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/stablyai/orca-go/services/infra-fleet-service/internal/domain"
)

// fakeDevServerAgentClient is an in-memory DevServerAgentClient — stands in
// for adapter/devserveragent's real stub in these usecase-layer tests, which
// only exercise dispatch logic, not the wire protocol. Also backs the
// Terminal/PTY usecase tests (spawn_terminal_session_test.go,
// attach_pty_test.go, wait_terminal_session_test.go, etc.) — guarded by mu
// since AttachPty drives calls from its own goroutine (see attach_pty.go's
// run method).
type fakeDevServerAgentClient struct {
	mu sync.Mutex

	execResult map[string]any
	execErr    error
	execCalls  []string // methods called with, for assertions
	// execParams records the params map passed on each Exec call, in the
	// same order as execCalls — TASK-BE-EVM-001's recipeId/runtimeId
	// assertions need to inspect what was actually sent, not just the
	// method name.
	execParams []map[string]any

	// execCalled/lastMethod are a simpler single-call view of execCalls,
	// used by kill_workspace_port_test.go/establish_connection_test.go.
	execCalled bool
	lastMethod string

	// healthy/healthErr drive Health's fake answer — used by
	// establish_connection_test.go.
	healthy   bool
	healthErr error
	// isConnected drives IsConnected's fake answer.
	isConnected    bool
	spawnPtyResult SpawnPtyResult
	spawnPtyErr    error
	spawnPtyCalls  []SpawnPtyInput

	writePtyErr   error
	writePtyCalls [][]byte

	resizePtyErr   error
	resizePtyCalls []resizePtyCall

	killPtyErr   error
	killPtyCalls []string

	sendSignalErr   error
	sendSignalCalls []string // "ptyID:signal", for assertions

	// streamPtyEvents, if non-nil, is returned as-is from StreamPty — the
	// test owns writing to (and closing) it. streamPtyUnsubscribed records
	// whether the returned unsubscribe func was called.
	streamPtyEvents       chan PtyEvent
	streamPtyErr          error
	streamPtyUnsubscribed bool

	// streamScreencastEvents/Err/Unsubscribed mirror streamPtyEvents's
	// convention exactly, for StreamScreencast.
	streamScreencastEvents       chan ScreencastEvent
	streamScreencastErr          error
	streamScreencastUnsubscribed bool
	streamScreencastCalls        []ScreencastParams

	agentStatusResult AgentStatusResult
	agentStatusErr    error

	inspectResult InspectProcessResult
	inspectErr    error

	// streamVmProvisionEvents/Err/Unsubscribed/Calls mirror
	// streamScreencastEvents's convention exactly, for StreamVmProvision
	// (TASK-BE-EVM-003).
	streamVmProvisionEvents       chan VmProvisionEvent
	streamVmProvisionErr          error
	streamVmProvisionUnsubscribed bool
	streamVmProvisionCalls        []VmProvisionParams

	// dialHiddenSshTarget* drive DialHiddenSshTarget's fake answer —
	// TASK-BE-EVM-014's AgentOutboundSshProvisioner tests.
	dialHiddenSshTargetResult      string
	dialHiddenSshTargetFingerprint string
	dialHiddenSshTargetErr         error
	dialHiddenSshTargetCalls       []domain.EphemeralVmSshTarget

	// readCredentialFile* drive ReadCredentialFile's fake answer —
	// TASK-BE-EVM-017's BackendRelaySshProvisioner tests.
	readCredentialFileResult string
	readCredentialFileErr    error
	readCredentialFileCalls  []readCredentialFileCall
}

type readCredentialFileCall struct {
	devServer domain.DevServer
	path      string
}

type resizePtyCall struct {
	Cols, Rows int32
}

func (f *fakeDevServerAgentClient) Exec(ctx context.Context, devServer domain.DevServer, method string, params map[string]any) (map[string]any, error) {
	f.mu.Lock()
	f.execCalls = append(f.execCalls, method)
	f.execParams = append(f.execParams, params)
	f.execCalled = true
	f.lastMethod = method
	f.mu.Unlock()
	if f.execErr != nil {
		return nil, f.execErr
	}
	return f.execResult, nil
}

func (f *fakeDevServerAgentClient) Health(ctx context.Context, devServer domain.DevServer) (bool, error) {
	if f.healthErr != nil {
		return false, f.healthErr
	}
	return f.healthy, nil
}

func (f *fakeDevServerAgentClient) IsConnected(devServerID string) bool {
	return f.isConnected
}

func (f *fakeDevServerAgentClient) SpawnPty(ctx context.Context, devServer domain.DevServer, in SpawnPtyInput) (SpawnPtyResult, error) {
	f.mu.Lock()
	f.spawnPtyCalls = append(f.spawnPtyCalls, in)
	f.mu.Unlock()
	if f.spawnPtyErr != nil {
		return SpawnPtyResult{}, f.spawnPtyErr
	}
	return f.spawnPtyResult, nil
}

func (f *fakeDevServerAgentClient) WritePty(ctx context.Context, devServer domain.DevServer, ptyID string, data []byte) error {
	f.mu.Lock()
	f.writePtyCalls = append(f.writePtyCalls, data)
	f.mu.Unlock()
	return f.writePtyErr
}

func (f *fakeDevServerAgentClient) ResizePty(ctx context.Context, devServer domain.DevServer, ptyID string, cols, rows int32) error {
	f.mu.Lock()
	f.resizePtyCalls = append(f.resizePtyCalls, resizePtyCall{Cols: cols, Rows: rows})
	f.mu.Unlock()
	return f.resizePtyErr
}

func (f *fakeDevServerAgentClient) KillPty(ctx context.Context, devServer domain.DevServer, ptyID string, graceful bool) error {
	f.mu.Lock()
	f.killPtyCalls = append(f.killPtyCalls, ptyID)
	f.mu.Unlock()
	return f.killPtyErr
}

func (f *fakeDevServerAgentClient) SendSignal(ctx context.Context, devServer domain.DevServer, ptyID string, signal string) error {
	f.mu.Lock()
	f.sendSignalCalls = append(f.sendSignalCalls, ptyID+":"+signal)
	f.mu.Unlock()
	return f.sendSignalErr
}

func (f *fakeDevServerAgentClient) StreamPty(ctx context.Context, devServer domain.DevServer, ptyID string) (<-chan PtyEvent, func(), error) {
	if f.streamPtyErr != nil {
		return nil, nil, f.streamPtyErr
	}
	events := f.streamPtyEvents
	if events == nil {
		events = make(chan PtyEvent)
	}
	unsubscribe := func() {
		f.mu.Lock()
		f.streamPtyUnsubscribed = true
		f.mu.Unlock()
	}
	return events, unsubscribe, nil
}

func (f *fakeDevServerAgentClient) StreamScreencast(ctx context.Context, devServer domain.DevServer, params ScreencastParams) (<-chan ScreencastEvent, func(), error) {
	f.mu.Lock()
	f.streamScreencastCalls = append(f.streamScreencastCalls, params)
	f.mu.Unlock()
	if f.streamScreencastErr != nil {
		return nil, nil, f.streamScreencastErr
	}
	events := f.streamScreencastEvents
	if events == nil {
		events = make(chan ScreencastEvent)
	}
	unsubscribe := func() {
		f.mu.Lock()
		f.streamScreencastUnsubscribed = true
		f.mu.Unlock()
	}
	return events, unsubscribe, nil
}

func (f *fakeDevServerAgentClient) AgentStatus(ctx context.Context, devServer domain.DevServer, ptyID string) (AgentStatusResult, error) {
	if f.agentStatusErr != nil {
		return AgentStatusResult{}, f.agentStatusErr
	}
	return f.agentStatusResult, nil
}

func (f *fakeDevServerAgentClient) InspectProcess(ctx context.Context, devServer domain.DevServer, ptyID string) (InspectProcessResult, error) {
	if f.inspectErr != nil {
		return InspectProcessResult{}, f.inspectErr
	}
	return f.inspectResult, nil
}

func (f *fakeDevServerAgentClient) StreamVmProvision(ctx context.Context, devServer domain.DevServer, params VmProvisionParams) (<-chan VmProvisionEvent, func(), error) {
	f.mu.Lock()
	f.streamVmProvisionCalls = append(f.streamVmProvisionCalls, params)
	f.mu.Unlock()
	if f.streamVmProvisionErr != nil {
		return nil, nil, f.streamVmProvisionErr
	}
	events := f.streamVmProvisionEvents
	if events == nil {
		events = make(chan VmProvisionEvent)
	}
	unsubscribe := func() {
		f.mu.Lock()
		f.streamVmProvisionUnsubscribed = true
		f.mu.Unlock()
	}
	return events, unsubscribe, nil
}

func (f *fakeDevServerAgentClient) DialHiddenSshTarget(ctx context.Context, devServer domain.DevServer, runtimeID string, target domain.EphemeralVmSshTarget) (string, string, error) {
	f.mu.Lock()
	f.dialHiddenSshTargetCalls = append(f.dialHiddenSshTargetCalls, target)
	f.mu.Unlock()
	if f.dialHiddenSshTargetErr != nil {
		return "", "", f.dialHiddenSshTargetErr
	}
	hiddenTargetID := runtimeID
	if f.dialHiddenSshTargetResult != "" {
		hiddenTargetID = f.dialHiddenSshTargetResult
	}
	return hiddenTargetID, f.dialHiddenSshTargetFingerprint, nil
}

func (f *fakeDevServerAgentClient) ReadCredentialFile(ctx context.Context, devServer domain.DevServer, path string) (string, error) {
	f.mu.Lock()
	f.readCredentialFileCalls = append(f.readCredentialFileCalls, readCredentialFileCall{devServer: devServer, path: path})
	f.mu.Unlock()
	if f.readCredentialFileErr != nil {
		return "", f.readCredentialFileErr
	}
	return f.readCredentialFileResult, nil
}

func TestScanWorkspacePorts_RequiresTenantContext(t *testing.T) {
	uc := NewScanWorkspacePorts(&fakeConnectionResolver{}, &fakeDevServerAgentClient{})
	_, err := uc.Execute(context.Background(), ScanWorkspacePortsInput{})
	if err == nil {
		t.Fatal("expected an error when no tenant is in context")
	}
}

func TestScanWorkspacePorts_NoConnectionID_ReturnsEmptyWithoutRelaying(t *testing.T) {
	resolver := &fakeConnectionResolver{}
	agent := &fakeDevServerAgentClient{}
	uc := NewScanWorkspacePorts(resolver, agent)

	ctx := withTenant(context.Background(), "tenant-1")
	ports, err := uc.Execute(ctx, ScanWorkspacePortsInput{WorktreeID: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ports) != 0 {
		t.Errorf("expected no ports for a connectionless worktree, got %v", ports)
	}
	if len(agent.execCalls) != 0 {
		t.Error("expected no relay to the agent when no connectionId is set")
	}
}

// This is the regression test for TS Gap 7: a bound connectionId must
// always relay, never silently short-circuit to an empty result.
func TestScanWorkspacePorts_ConnectionIDBound_AlwaysRelays(t *testing.T) {
	ds, err := domain.NewDevServer("ds1", "tenant-1", "10.0.0.5", domain.ConnectionModeRelaySSH, "ssht1")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{"conn-1": ds}}
	agent := &fakeDevServerAgentClient{execResult: map[string]any{"openPorts": []any{float64(3000), float64(8080)}}}
	uc := NewScanWorkspacePorts(resolver, agent)

	ctx := withTenant(context.Background(), "tenant-1")
	ports, err := uc.Execute(ctx, ScanWorkspacePortsInput{ConnectionID: "conn-1", WorktreeID: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(agent.execCalls) != 1 || agent.execCalls[0] != "ports.scan" {
		t.Fatalf("expected exactly one ports.scan relay call, got %v", agent.execCalls)
	}
	if len(ports) != 2 || ports[0] != 3000 || ports[1] != 8080 {
		t.Errorf("expected [3000 8080], got %v", ports)
	}
}

// A bound connectionId whose agent call fails must propagate the error, not
// swallow it into an empty result — the exact bug class TS Gap 7 describes.
func TestScanWorkspacePorts_ConnectionIDBound_AgentFailurePropagates(t *testing.T) {
	ds, err := domain.NewDevServer("ds1", "tenant-1", "10.0.0.5", domain.ConnectionModeRelaySSH, "ssht1")
	if err != nil {
		t.Fatalf("building dev server: %v", err)
	}
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{"conn-1": ds}}
	agent := &fakeDevServerAgentClient{execErr: errors.New("devserveragent: not implemented")}
	uc := NewScanWorkspacePorts(resolver, agent)

	ctx := withTenant(context.Background(), "tenant-1")
	_, err = uc.Execute(ctx, ScanWorkspacePortsInput{ConnectionID: "conn-1", WorktreeID: "wt-1"})
	if err == nil {
		t.Fatal("expected the agent's error to propagate, not be swallowed into an empty result")
	}
}

func TestScanWorkspacePorts_ConnectionIDNotResolved_ReturnsEmptyWithoutRelaying(t *testing.T) {
	resolver := &fakeConnectionResolver{byConnectionID: map[string]domain.DevServer{}}
	agent := &fakeDevServerAgentClient{}
	uc := NewScanWorkspacePorts(resolver, agent)

	ctx := withTenant(context.Background(), "tenant-1")
	ports, err := uc.Execute(ctx, ScanWorkspacePortsInput{ConnectionID: "unknown-conn", WorktreeID: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(ports) != 0 {
		t.Errorf("expected no ports when the connectionId doesn't resolve, got %v", ports)
	}
	if len(agent.execCalls) != 0 {
		t.Error("expected no relay to the agent when the connectionId doesn't resolve to a live dev server")
	}
}
