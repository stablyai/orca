package grpcclient

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"google.golang.org/grpc"

	"github.com/stablyai/orca-go/common/apperrors"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	"github.com/stablyai/orca-go/services/task-service/internal/domain"
)

// fakeInfraFleetServiceClient implements infrafleetv1.InfraFleetServiceClient
// directly (no bufconn/wire-level gRPC) — this package's tests fake the
// port (the generated client interface), not the transport, mirroring
// git-gateway-service/internal/adapter/grpcclient's fake of the same name.
type fakeInfraFleetServiceClient struct {
	infrafleetv1.InfraFleetServiceClient // embed: panics on any unimplemented method, intentional for these tests

	resolveConnectionResp *infrafleetv1.ResolveConnectionResponse
	resolveConnectionErr  error
	gotResolveConnection  *infrafleetv1.ResolveConnectionRequest

	relayResp *infrafleetv1.RelayResponse
	relayErr  error
	gotRelay  *infrafleetv1.RelayRequest
}

func (f *fakeInfraFleetServiceClient) ResolveConnection(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest, _ ...grpc.CallOption) (*infrafleetv1.ResolveConnectionResponse, error) {
	f.gotResolveConnection = in
	if f.resolveConnectionErr != nil {
		return nil, f.resolveConnectionErr
	}
	return f.resolveConnectionResp, nil
}

func (f *fakeInfraFleetServiceClient) Relay(ctx context.Context, in *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
	f.gotRelay = in
	if f.relayErr != nil {
		return nil, f.relayErr
	}
	return f.relayResp, nil
}

// fakeTaskRepository backs SimpleExecutor's tests without a database —
// only Get is exercised here, so the rest of usecase.TaskRepository panics
// via the embed if a test ever calls something unexpected.
type fakeTaskRepository struct {
	tasks map[string]domain.Task
}

func (f *fakeTaskRepository) Create(ctx context.Context, task domain.Task) (domain.Task, error) {
	panic("not implemented")
}
func (f *fakeTaskRepository) Get(ctx context.Context, tenantID, id string) (domain.Task, error) {
	t, ok := f.tasks[id]
	if !ok {
		return domain.Task{}, errors.New("not found")
	}
	return t, nil
}
func (f *fakeTaskRepository) GetAncestors(ctx context.Context, tenantID, id string, maxDepth int) ([]domain.Task, error) {
	panic("not implemented")
}
func (f *fakeTaskRepository) UpdateStatus(ctx context.Context, tenantID, id, status string) error {
	panic("not implemented")
}
func (f *fakeTaskRepository) HasActiveExecutions(ctx context.Context, tenantID, projectID string) (bool, error) {
	panic("not implemented")
}
func (f *fakeTaskRepository) List(ctx context.Context, tenantID, projectID, pageToken string, pageSize int32) ([]domain.Task, string, error) {
	panic("not implemented")
}
func (f *fakeTaskRepository) Update(ctx context.Context, tenantID string, task domain.Task) error {
	panic("not implemented")
}
func (f *fakeTaskRepository) Delete(ctx context.Context, tenantID, id string) error {
	panic("not implemented")
}

// fakeProjectExecutionResolver backs SimpleExecutor's tests without a real
// infra-fleet-service call.
type fakeProjectExecutionResolver struct {
	connectionID string
	worktreePath string
	connected    bool
	err          error
}

func (f *fakeProjectExecutionResolver) ResolveConnection(ctx context.Context, tenantID, projectID string) (string, string, bool, error) {
	return f.connectionID, f.worktreePath, f.connected, f.err
}

// TestSimpleExecutor_Execute_RelaysAgentExecPrompt locks in TASK-224 Gap 1's
// fix: SimpleExecutor must call "agent.execPrompt" (prompt/worktreePath),
// not "agent.exec" (binary/args/cwd) — see simple_executor.go's doc comment
// for the full source citation behind this.
func TestSimpleExecutor_Execute_RelaysAgentExecPrompt(t *testing.T) {
	tasks := &fakeTaskRepository{tasks: map[string]domain.Task{"t1": {ID: "t1", ProjectID: "p1", Title: "Do the thing"}}}
	resolver := &fakeProjectExecutionResolver{connectionID: "conn-1", worktreePath: "/srv/worktrees/p1", connected: true}
	relay := &fakeInfraFleetServiceClient{
		relayResp: &infrafleetv1.RelayResponse{ResultJson: `{"stdout":"done","stderr":"","exitCode":0,"timedOut":false}`},
	}
	exec := NewSimpleExecutor(tasks, resolver, relay)

	ref, err := exec.Execute(context.Background(), "tenant-1", "t1", "req-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ref != "task-exec:t1:req-1" {
		t.Errorf("expected a synthesized executionRef, got %q", ref)
	}
	if relay.gotRelay.GetMethod() != "agent.execPrompt" {
		t.Errorf("expected method=agent.execPrompt, got %q", relay.gotRelay.GetMethod())
	}
	if relay.gotRelay.GetConnectionId() != "conn-1" {
		t.Errorf("expected resolved connectionId to be used, got %q", relay.gotRelay.GetConnectionId())
	}
	var sentParams agentExecPromptParams
	if err := json.Unmarshal([]byte(relay.gotRelay.GetParamsJson()), &sentParams); err != nil {
		t.Fatalf("params_json didn't decode: %v", err)
	}
	if sentParams.WorktreePath != "/srv/worktrees/p1" {
		t.Errorf("expected resolved worktreePath to be forwarded, got %q", sentParams.WorktreePath)
	}
	if sentParams.Prompt == "" {
		t.Error("expected a non-empty prompt naming the task")
	}
}

// TestSimpleExecutor_NotConnected_ReturnsTypedError locks in that the stub
// behavior (a synthesized placeholder ref, no error) is actually gone.
func TestSimpleExecutor_NotConnected_ReturnsTypedError(t *testing.T) {
	tasks := &fakeTaskRepository{tasks: map[string]domain.Task{"t1": {ID: "t1", ProjectID: "p1"}}}
	resolver := &fakeProjectExecutionResolver{connected: false}
	exec := NewSimpleExecutor(tasks, resolver, &fakeInfraFleetServiceClient{})

	_, err := exec.Execute(context.Background(), "tenant-1", "t1", "req-1", "")
	if err == nil {
		t.Fatal("expected a real error for a not-connected project, not a synthesized placeholder ref")
	}
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition, got %v", err)
	}
}

// TestSimpleExecutor_ConnectedButNoWorktreePath_ReturnsTypedError covers
// agent.execPrompt's required worktreePath field having nothing to resolve
// it from — a distinct failure mode from "not connected at all".
func TestSimpleExecutor_ConnectedButNoWorktreePath_ReturnsTypedError(t *testing.T) {
	tasks := &fakeTaskRepository{tasks: map[string]domain.Task{"t1": {ID: "t1", ProjectID: "p1"}}}
	resolver := &fakeProjectExecutionResolver{connectionID: "conn-1", connected: true, worktreePath: ""}
	exec := NewSimpleExecutor(tasks, resolver, &fakeInfraFleetServiceClient{})

	_, err := exec.Execute(context.Background(), "tenant-1", "t1", "req-1", "")
	if err == nil {
		t.Fatal("expected a real error when connected but no worktreePath resolved")
	}
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition, got %v", err)
	}
}

func TestSimpleExecutor_TaskNotFound(t *testing.T) {
	exec := NewSimpleExecutor(&fakeTaskRepository{tasks: map[string]domain.Task{}}, &fakeProjectExecutionResolver{}, &fakeInfraFleetServiceClient{})
	if _, err := exec.Execute(context.Background(), "tenant-1", "does-not-exist", "req-1", ""); err == nil {
		t.Fatal("expected an error for a nonexistent task")
	}
}

func TestSimpleExecutor_RelayErrorPropagates(t *testing.T) {
	tasks := &fakeTaskRepository{tasks: map[string]domain.Task{"t1": {ID: "t1", ProjectID: "p1"}}}
	resolver := &fakeProjectExecutionResolver{connectionID: "conn-1", worktreePath: "/srv/worktrees/p1", connected: true}
	relay := &fakeInfraFleetServiceClient{relayErr: errors.New("boom")}
	exec := NewSimpleExecutor(tasks, resolver, relay)

	if _, err := exec.Execute(context.Background(), "tenant-1", "t1", "req-1", ""); err == nil {
		t.Fatal("expected an error when the relay call fails")
	}
}

// TestSimpleExecutor_NonZeroExitCode_ReturnsError proves a failed
// agent.execPrompt run (non-zero exit) surfaces as a real error rather than
// a successful executionRef — there is no separate completion callback to
// catch this later (see simple_executor.go's doc comment's honest-limits
// note).
func TestSimpleExecutor_NonZeroExitCode_ReturnsError(t *testing.T) {
	tasks := &fakeTaskRepository{tasks: map[string]domain.Task{"t1": {ID: "t1", ProjectID: "p1"}}}
	resolver := &fakeProjectExecutionResolver{connectionID: "conn-1", worktreePath: "/srv/worktrees/p1", connected: true}
	relay := &fakeInfraFleetServiceClient{
		relayResp: &infrafleetv1.RelayResponse{ResultJson: `{"stdout":"","stderr":"boom","exitCode":1,"timedOut":false}`},
	}
	exec := NewSimpleExecutor(tasks, resolver, relay)

	if _, err := exec.Execute(context.Background(), "tenant-1", "t1", "req-1", ""); err == nil {
		t.Fatal("expected an error for a non-zero agent.execPrompt exit code")
	}
}

// TestSimpleExecutor_TimedOut_ReturnsError mirrors the non-zero-exit case
// for agent.execPrompt's other failure signal.
func TestSimpleExecutor_TimedOut_ReturnsError(t *testing.T) {
	tasks := &fakeTaskRepository{tasks: map[string]domain.Task{"t1": {ID: "t1", ProjectID: "p1"}}}
	resolver := &fakeProjectExecutionResolver{connectionID: "conn-1", worktreePath: "/srv/worktrees/p1", connected: true}
	relay := &fakeInfraFleetServiceClient{
		relayResp: &infrafleetv1.RelayResponse{ResultJson: `{"stdout":"","stderr":"","exitCode":null,"timedOut":true}`},
	}
	exec := NewSimpleExecutor(tasks, resolver, relay)

	if _, err := exec.Execute(context.Background(), "tenant-1", "t1", "req-1", ""); err == nil {
		t.Fatal("expected an error for a timed-out agent.execPrompt run")
	}
}
