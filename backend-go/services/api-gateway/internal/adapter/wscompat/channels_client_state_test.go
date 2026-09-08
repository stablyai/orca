package wscompat

import (
	"context"
	"encoding/json"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	tenantv1 "github.com/stablyai/orca-go/proto/gen/go/orca/tenant/v1"
)

// fakeTenantServiceClientForClientState is a minimal test double local to
// this file — embeds the (nil) interface and overrides only the 5 methods
// registerClientStateChannels' handlers call, mirroring
// fakeTenantServiceClientForOnboarding/fakeTenantServiceClientForAdmin's
// exact shape elsewhere in this package.
type fakeTenantServiceClientForClientState struct {
	tenantv1.TenantServiceClient

	getClientStateFunc        func(ctx context.Context, in *tenantv1.GetClientStateRequest) (*tenantv1.GetClientStateResponse, error)
	setClientStateFunc        func(ctx context.Context, in *tenantv1.SetClientStateRequest) (*emptypb.Empty, error)
	getWorkspaceSessionFunc   func(ctx context.Context, in *tenantv1.GetWorkspaceSessionRequest) (*tenantv1.GetWorkspaceSessionResponse, error)
	setWorkspaceSessionFunc   func(ctx context.Context, in *tenantv1.SetWorkspaceSessionRequest) (*emptypb.Empty, error)
	patchWorkspaceSessionFunc func(ctx context.Context, in *tenantv1.PatchWorkspaceSessionRequest) (*emptypb.Empty, error)
}

func (f *fakeTenantServiceClientForClientState) GetClientState(ctx context.Context, in *tenantv1.GetClientStateRequest, _ ...grpc.CallOption) (*tenantv1.GetClientStateResponse, error) {
	return f.getClientStateFunc(ctx, in)
}

func (f *fakeTenantServiceClientForClientState) SetClientState(ctx context.Context, in *tenantv1.SetClientStateRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.setClientStateFunc(ctx, in)
}

func (f *fakeTenantServiceClientForClientState) GetWorkspaceSession(ctx context.Context, in *tenantv1.GetWorkspaceSessionRequest, _ ...grpc.CallOption) (*tenantv1.GetWorkspaceSessionResponse, error) {
	return f.getWorkspaceSessionFunc(ctx, in)
}

func (f *fakeTenantServiceClientForClientState) SetWorkspaceSession(ctx context.Context, in *tenantv1.SetWorkspaceSessionRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.setWorkspaceSessionFunc(ctx, in)
}

func (f *fakeTenantServiceClientForClientState) PatchWorkspaceSession(ctx context.Context, in *tenantv1.PatchWorkspaceSessionRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.patchWorkspaceSessionFunc(ctx, in)
}

func rawArgsClientState(t *testing.T, v any) []json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal args: %v", err)
	}
	return []json.RawMessage{b}
}

// TestClientStateGetChannel_UserIDComesFromIdentityNotArgs is the
// regression guard BE-SOL-STORAGE-001 §7 calls for — mirrors
// TestWorkflowExecuteAdHocStepChannel_TenantIDComesFromIdentityNotArgs
// (BE-SOL-001): a forged userId in args must never reach the outbound RPC.
func TestClientStateGetChannel_UserIDComesFromIdentityNotArgs(t *testing.T) {
	var gotReq *tenantv1.GetClientStateRequest
	fake := &fakeTenantServiceClientForClientState{
		getClientStateFunc: func(ctx context.Context, in *tenantv1.GetClientStateRequest) (*tenantv1.GetClientStateResponse, error) {
			gotReq = in
			return &tenantv1.GetClientStateResponse{Found: false}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "real-user"}
	args := rawArgsClientState(t, map[string]any{"kind": "keybindings", "userId": "forged-user"})
	if _, err := r.Dispatch(context.Background(), id, "clientState.get", args); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq == nil {
		t.Fatal("expected GetClientState to be called")
	}
	if gotReq.GetUserId() != "real-user" {
		t.Errorf("want UserId=%q (from Identity), got %q (args leaked through)", "real-user", gotReq.GetUserId())
	}
}

func TestClientStateGetChannel_NotFoundReturnsFoundFalse(t *testing.T) {
	fake := &fakeTenantServiceClientForClientState{
		getClientStateFunc: func(ctx context.Context, in *tenantv1.GetClientStateRequest) (*tenantv1.GetClientStateResponse, error) {
			return &tenantv1.GetClientStateResponse{Found: false}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "user-1"}
	args := rawArgsClientState(t, map[string]any{"kind": "settings"})
	got, err := r.Dispatch(context.Background(), id, "clientState.get", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("expected a map result, got %T", got)
	}
	if found, _ := m["found"].(bool); found {
		t.Error("want found=false")
	}
	if _, hasStateJSON := m["stateJson"]; hasStateJSON {
		t.Error("expected no stateJson key when not found")
	}
}

func TestClientStateGetChannel_FoundReturnsStateJSON(t *testing.T) {
	fake := &fakeTenantServiceClientForClientState{
		getClientStateFunc: func(ctx context.Context, in *tenantv1.GetClientStateRequest) (*tenantv1.GetClientStateResponse, error) {
			if in.GetKind() != tenantv1.ClientStateKind_CLIENT_STATE_KIND_UI_LOCAL {
				t.Errorf("expected kind=UI_LOCAL, got %v", in.GetKind())
			}
			return &tenantv1.GetClientStateResponse{Found: true, StateJson: `{"sidebarWidth":240}`}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "user-1"}
	args := rawArgsClientState(t, map[string]any{"kind": "uiLocal"})
	got, err := r.Dispatch(context.Background(), id, "clientState.get", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := got.(map[string]any)
	if found, _ := m["found"].(bool); !found {
		t.Error("want found=true")
	}
	if m["stateJson"] != `{"sidebarWidth":240}` {
		t.Errorf("want stateJson round-tripped, got %v", m["stateJson"])
	}
}

func TestClientStateGetChannel_UnknownKindReturnsError(t *testing.T) {
	fake := &fakeTenantServiceClientForClientState{}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "user-1"}
	args := rawArgsClientState(t, map[string]any{"kind": "bogus"})
	if _, err := r.Dispatch(context.Background(), id, "clientState.get", args); err == nil {
		t.Fatal("expected an error for an unknown kind")
	}
}

// TestClientStateSetChannel_UnknownKindReturnsError also confirms an
// unknown kind never reaches SetClientState at all (setClientStateFunc left
// nil would panic if invoked).
func TestClientStateSetChannel_UnknownKindReturnsError(t *testing.T) {
	fake := &fakeTenantServiceClientForClientState{}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "user-1"}
	args := rawArgsClientState(t, map[string]any{"kind": "bogus", "stateJson": "{}"})
	if _, err := r.Dispatch(context.Background(), id, "clientState.set", args); err == nil {
		t.Fatal("expected an error for an unknown kind")
	}
}

func TestClientStateSetChannel_UserIDComesFromIdentityNotArgs(t *testing.T) {
	var gotReq *tenantv1.SetClientStateRequest
	fake := &fakeTenantServiceClientForClientState{
		setClientStateFunc: func(ctx context.Context, in *tenantv1.SetClientStateRequest) (*emptypb.Empty, error) {
			gotReq = in
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "real-user"}
	args := rawArgsClientState(t, map[string]any{"kind": "keybindings", "stateJson": "{}", "userId": "forged-user"})
	if _, err := r.Dispatch(context.Background(), id, "clientState.set", args); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetUserId() != "real-user" {
		t.Errorf("want UserId=%q, got %q", "real-user", gotReq.GetUserId())
	}
}

func TestWorkspaceSessionGetChannel_ScopedByHostId(t *testing.T) {
	var gotHostID string
	fake := &fakeTenantServiceClientForClientState{
		getWorkspaceSessionFunc: func(ctx context.Context, in *tenantv1.GetWorkspaceSessionRequest) (*tenantv1.GetWorkspaceSessionResponse, error) {
			gotHostID = in.GetHostId()
			return &tenantv1.GetWorkspaceSessionResponse{Found: true, SessionJson: `{"host":"` + in.GetHostId() + `"}`}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "user-1"}
	args := rawArgsClientState(t, map[string]any{"hostId": "env-1"})
	got, err := r.Dispatch(context.Background(), id, "workspaceSession.get", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotHostID != "env-1" {
		t.Errorf("want hostId=%q forwarded, got %q", "env-1", gotHostID)
	}
	m := got.(map[string]any)
	if m["sessionJson"] != `{"host":"env-1"}` {
		t.Errorf("unexpected sessionJson: %v", m["sessionJson"])
	}
}

func TestWorkspaceSessionGetChannel_UserIDComesFromIdentityNotArgs(t *testing.T) {
	var gotReq *tenantv1.GetWorkspaceSessionRequest
	fake := &fakeTenantServiceClientForClientState{
		getWorkspaceSessionFunc: func(ctx context.Context, in *tenantv1.GetWorkspaceSessionRequest) (*tenantv1.GetWorkspaceSessionResponse, error) {
			gotReq = in
			return &tenantv1.GetWorkspaceSessionResponse{Found: false}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "real-user"}
	args := rawArgsClientState(t, map[string]any{"hostId": "local", "userId": "forged-user"})
	if _, err := r.Dispatch(context.Background(), id, "workspaceSession.get", args); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetUserId() != "real-user" {
		t.Errorf("want UserId=%q, got %q", "real-user", gotReq.GetUserId())
	}
}

func TestWorkspaceSessionSetChannel_ForwardsSessionJson(t *testing.T) {
	var gotReq *tenantv1.SetWorkspaceSessionRequest
	fake := &fakeTenantServiceClientForClientState{
		setWorkspaceSessionFunc: func(ctx context.Context, in *tenantv1.SetWorkspaceSessionRequest) (*emptypb.Empty, error) {
			gotReq = in
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "user-1"}
	args := rawArgsClientState(t, map[string]any{"hostId": "local", "sessionJson": `{"tabs":[]}`})
	if _, err := r.Dispatch(context.Background(), id, "workspaceSession.set", args); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetSessionJson() != `{"tabs":[]}` {
		t.Errorf("unexpected SessionJson: %q", gotReq.GetSessionJson())
	}
	if gotReq.GetUserId() != "user-1" {
		t.Errorf("want UserId=%q, got %q", "user-1", gotReq.GetUserId())
	}
}

func TestWorkspaceSessionPatchChannel_ForwardsPatchJson(t *testing.T) {
	var gotReq *tenantv1.PatchWorkspaceSessionRequest
	fake := &fakeTenantServiceClientForClientState{
		patchWorkspaceSessionFunc: func(ctx context.Context, in *tenantv1.PatchWorkspaceSessionRequest) (*emptypb.Empty, error) {
			gotReq = in
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerClientStateChannels(r, fake)

	id := Identity{TenantID: "tenant-1", UserID: "real-user"}
	args := rawArgsClientState(t, map[string]any{"hostId": "local", "patchJson": `{"activeTab":"x"}`, "userId": "forged-user"})
	if _, err := r.Dispatch(context.Background(), id, "workspaceSession.patch", args); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetPatchJson() != `{"activeTab":"x"}` {
		t.Errorf("unexpected PatchJson: %q", gotReq.GetPatchJson())
	}
	if gotReq.GetUserId() != "real-user" {
		t.Errorf("want UserId=%q (from Identity), got %q", "real-user", gotReq.GetUserId())
	}
	if gotReq.GetHostId() != "local" {
		t.Errorf("want HostId=%q, got %q", "local", gotReq.GetHostId())
	}
}
