package wscompat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"google.golang.org/grpc"

	orchestrationv1 "github.com/stablyai/orca-go/proto/gen/go/orca/orchestration/v1"
)

type fakeOrchestrationClient struct {
	orchestrationv1.OrchestrationServiceClient

	getDispatchContextForTaskFunc         func(ctx context.Context, in *orchestrationv1.GetDispatchContextForTaskRequest) (*orchestrationv1.GetDispatchContextForTaskResponse, error)
	listActiveDispatchContextsForUserFunc func(ctx context.Context, in *orchestrationv1.ListActiveDispatchContextsForUserRequest) (*orchestrationv1.ListActiveDispatchContextsForUserResponse, error)
}

func (f *fakeOrchestrationClient) GetDispatchContextForTask(ctx context.Context, in *orchestrationv1.GetDispatchContextForTaskRequest, _ ...grpc.CallOption) (*orchestrationv1.GetDispatchContextForTaskResponse, error) {
	return f.getDispatchContextForTaskFunc(ctx, in)
}

func (f *fakeOrchestrationClient) ListActiveDispatchContextsForUser(ctx context.Context, in *orchestrationv1.ListActiveDispatchContextsForUserRequest, _ ...grpc.CallOption) (*orchestrationv1.ListActiveDispatchContextsForUserResponse, error) {
	return f.listActiveDispatchContextsForUserFunc(ctx, in)
}

func TestDispatchShowChannel_ReturnsAssigneeHandle(t *testing.T) {
	fake := &fakeOrchestrationClient{
		getDispatchContextForTaskFunc: func(ctx context.Context, in *orchestrationv1.GetDispatchContextForTaskRequest) (*orchestrationv1.GetDispatchContextForTaskResponse, error) {
			if in.GetOrchestrationTaskId() != "task-1" {
				t.Fatalf("want task-1, got %q", in.GetOrchestrationTaskId())
			}
			return &orchestrationv1.GetDispatchContextForTaskResponse{
				Dispatch: &orchestrationv1.DispatchContext{Id: "dc-1", Handle: "terminal-3", OrchestrationTaskId: "task-1"},
			}, nil
		},
	}
	r := NewRegistry()
	registerOrchestrationChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1", UserID: "u1"}, "orchestration.dispatchShow", argsJSON(t, map[string]any{"task": "task-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("want map result, got %T", result)
	}
	dv, ok := out["dispatch"].(dispatchView)
	if !ok {
		t.Fatalf("want dispatch to be a dispatchView, got %T", out["dispatch"])
	}
	if dv.AssigneeHandle != "terminal-3" {
		t.Errorf("want dispatch.assignee_handle == terminal-3 (from DispatchContext.handle), got %q — regression guard for the wire-naming translation", dv.AssigneeHandle)
	}
}

func TestDispatchShowChannel_NoDispatchYet_ReturnsNilDispatch(t *testing.T) {
	fake := &fakeOrchestrationClient{
		getDispatchContextForTaskFunc: func(ctx context.Context, in *orchestrationv1.GetDispatchContextForTaskRequest) (*orchestrationv1.GetDispatchContextForTaskResponse, error) {
			return &orchestrationv1.GetDispatchContextForTaskResponse{}, nil // unset Dispatch
		},
	}
	r := NewRegistry()
	registerOrchestrationChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "orchestration.dispatchShow", argsJSON(t, map[string]any{"task": "task-none"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out, ok := result.(map[string]any)
	if !ok || out["dispatch"] != nil {
		t.Fatalf("want {dispatch: nil}, got %+v", result)
	}
}

func TestDispatchShowChannel_PropagatesError(t *testing.T) {
	wantErr := errors.New("orchestration-service unavailable")
	fake := &fakeOrchestrationClient{
		getDispatchContextForTaskFunc: func(ctx context.Context, in *orchestrationv1.GetDispatchContextForTaskRequest) (*orchestrationv1.GetDispatchContextForTaskResponse, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerOrchestrationChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "orchestration.dispatchShow", argsJSON(t, map[string]any{"task": "task-1"}))
	if !errors.Is(err, wantErr) {
		t.Fatalf("want %v, got %v", wantErr, err)
	}
}

// TestAgentSessionListActiveChannel_UserIDComesFromIdentityNotArgs mirrors
// TestConnectivityGetSummaryChannel_UserIDComesFromIdentityNotArgs's pattern
// (channels_infra_fleet_test.go) for the same regression class:
// ListActiveDispatchContextsForUserRequest is deliberately empty, so
// scoping must travel only via AttachIdentity's outgoing gRPC metadata.
func TestAgentSessionListActiveChannel_UserIDComesFromIdentityNotArgs(t *testing.T) {
	var gotCtx context.Context
	fake := &fakeOrchestrationClient{
		listActiveDispatchContextsForUserFunc: func(ctx context.Context, in *orchestrationv1.ListActiveDispatchContextsForUserRequest) (*orchestrationv1.ListActiveDispatchContextsForUserResponse, error) {
			gotCtx = ctx
			return &orchestrationv1.ListActiveDispatchContextsForUserResponse{}, nil
		},
	}
	r := NewRegistry()
	registerOrchestrationChannels(r, fake)

	args := argsJSON(t, map[string]any{"tenantId": "attacker-tenant", "userId": "attacker-user"})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-real", UserID: "user-real"}, "agentSession.listActive", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	tenant, user := outgoingTenantUser(gotCtx)
	if tenant != "tenant-real" {
		t.Errorf("want TenantID from Identity (tenant-real), got %q", tenant)
	}
	if user != "user-real" {
		t.Errorf("want UserID from Identity (user-real), got %q", user)
	}
}

func TestAgentSessionListActiveChannel_ReturnsCamelCaseFields(t *testing.T) {
	fake := &fakeOrchestrationClient{
		listActiveDispatchContextsForUserFunc: func(ctx context.Context, in *orchestrationv1.ListActiveDispatchContextsForUserRequest) (*orchestrationv1.ListActiveDispatchContextsForUserResponse, error) {
			return &orchestrationv1.ListActiveDispatchContextsForUserResponse{
				DispatchContexts: []*orchestrationv1.DispatchContext{
					{
						Id: "dc-1", OrchestrationTaskId: "task-1", Handle: "terminal-3",
						Status: "dispatched", FailureCount: 2, LastHeartbeatAt: "2026-09-08T00:00:00Z",
					},
				},
			}, nil
		},
	}
	r := NewRegistry()
	registerOrchestrationChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1", UserID: "u1"}, "agentSession.listActive", argsJSON(t, map[string]any{}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	b, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	s := string(b)
	for _, want := range []string{`"orchestrationTaskId"`, `"assigneeHandle"`, `"failureCount"`, `"lastHeartbeatAt"`} {
		if !strings.Contains(s, want) {
			t.Errorf("want camelCase key %s in response, got: %s", want, s)
		}
	}
	if strings.Contains(s, `"orchestration_task_id"`) || strings.Contains(s, `"failure_count"`) {
		t.Errorf("want no snake_case keys in response, got: %s", s)
	}
}

func TestAgentSessionListActiveChannel_EmptyReturnsEmptyArrayNotNull(t *testing.T) {
	fake := &fakeOrchestrationClient{
		listActiveDispatchContextsForUserFunc: func(ctx context.Context, in *orchestrationv1.ListActiveDispatchContextsForUserRequest) (*orchestrationv1.ListActiveDispatchContextsForUserResponse, error) {
			return &orchestrationv1.ListActiveDispatchContextsForUserResponse{}, nil
		},
	}
	r := NewRegistry()
	registerOrchestrationChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1", UserID: "u1"}, "agentSession.listActive", argsJSON(t, map[string]any{}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("want map result, got %T", result)
	}
	sessions, ok := out["agentSessions"].([]agentSessionView)
	if !ok {
		t.Fatalf("want agentSessions to be []agentSessionView, got %T", out["agentSessions"])
	}
	if sessions == nil {
		t.Error("want empty slice, got nil (would serialize as JSON null, not [])")
	}
	if len(sessions) != 0 {
		t.Errorf("want 0 sessions, got %d", len(sessions))
	}
}
