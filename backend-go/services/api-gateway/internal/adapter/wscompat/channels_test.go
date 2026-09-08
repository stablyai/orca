package wscompat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/common/grpcmw"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
)

// fakeInfraFleetClient is a minimal test double for
// infrafleetv1.InfraFleetServiceClient — embeds the (nil) interface so it
// satisfies every method, and overrides only the three this file's channel
// handlers actually call. Calling an unset method panics on a nil-pointer
// deref, which is fine: no test here should ever reach one.
type fakeInfraFleetClient struct {
	infrafleetv1.InfraFleetServiceClient

	listDevServersFunc       func(ctx context.Context, in *infrafleetv1.ListDevServersRequest) (*infrafleetv1.ListDevServersResponse, error)
	registerDevServerFunc    func(ctx context.Context, in *infrafleetv1.RegisterDevServerRequest) (*infrafleetv1.RegisterDevServerResponse, error)
	getFleetHealthFunc       func(ctx context.Context, in *infrafleetv1.GetFleetHealthRequest) (*infrafleetv1.GetFleetHealthResponse, error)
	relayFunc                func(ctx context.Context, in *infrafleetv1.RelayRequest) (*infrafleetv1.RelayResponse, error)
	relayByDevServerFunc     func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error)
	isDevServerConnectedFunc func(ctx context.Context, in *infrafleetv1.IsDevServerConnectedRequest) (*infrafleetv1.IsDevServerConnectedResponse, error)
	resolveConnectionFunc    func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error)
	listSshTargetsFunc       func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error)

	// CR-DS-006 Phase 2 / CR-DS-007 / CR-DS-008 fakes.
	listDevServerGroupsFunc     func(ctx context.Context, in *infrafleetv1.ListDevServerGroupsRequest) (*infrafleetv1.ListDevServerGroupsResponse, error)
	listDevServersForUserFunc   func(ctx context.Context, in *infrafleetv1.ListDevServersForUserRequest) (*infrafleetv1.ListDevServersForUserResponse, error)
	createAccessRequestFunc     func(ctx context.Context, in *infrafleetv1.CreateAccessRequestRequest) (*infrafleetv1.CreateAccessRequestResponse, error)
	lastListDevServersForUserIn *infrafleetv1.ListDevServersForUserRequest
	lastCreateAccessRequestIn   *infrafleetv1.CreateAccessRequestRequest

	// TASK-BE-STORAGE-008: connectivity.getSummary.
	getFleetConnectivitySummaryFunc    func(ctx context.Context, in *infrafleetv1.GetFleetConnectivitySummaryRequest) (*infrafleetv1.GetFleetConnectivitySummaryResponse, error)
	lastGetFleetConnectivitySummaryCtx context.Context

	// connection.teardown (TASK-BE-STORAGE-012 wscompat follow-up).
	teardownConnectionFunc    func(ctx context.Context, in *infrafleetv1.TeardownConnectionRequest) (*emptypb.Empty, error)
	lastTeardownConnectionCtx context.Context
	lastTeardownConnectionIn  *infrafleetv1.TeardownConnectionRequest
}

func (f *fakeInfraFleetClient) TeardownConnection(ctx context.Context, in *infrafleetv1.TeardownConnectionRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	f.lastTeardownConnectionCtx = ctx
	f.lastTeardownConnectionIn = in
	if f.teardownConnectionFunc != nil {
		return f.teardownConnectionFunc(ctx, in)
	}
	return &emptypb.Empty{}, nil
}

func (f *fakeInfraFleetClient) GetFleetConnectivitySummary(ctx context.Context, in *infrafleetv1.GetFleetConnectivitySummaryRequest, _ ...grpc.CallOption) (*infrafleetv1.GetFleetConnectivitySummaryResponse, error) {
	f.lastGetFleetConnectivitySummaryCtx = ctx
	return f.getFleetConnectivitySummaryFunc(ctx, in)
}

func (f *fakeInfraFleetClient) ListDevServerGroups(ctx context.Context, in *infrafleetv1.ListDevServerGroupsRequest, _ ...grpc.CallOption) (*infrafleetv1.ListDevServerGroupsResponse, error) {
	return f.listDevServerGroupsFunc(ctx, in)
}

func (f *fakeInfraFleetClient) ListDevServersForUser(ctx context.Context, in *infrafleetv1.ListDevServersForUserRequest, _ ...grpc.CallOption) (*infrafleetv1.ListDevServersForUserResponse, error) {
	f.lastListDevServersForUserIn = in
	return f.listDevServersForUserFunc(ctx, in)
}

func (f *fakeInfraFleetClient) CreateAccessRequest(ctx context.Context, in *infrafleetv1.CreateAccessRequestRequest, _ ...grpc.CallOption) (*infrafleetv1.CreateAccessRequestResponse, error) {
	f.lastCreateAccessRequestIn = in
	return f.createAccessRequestFunc(ctx, in)
}

func (f *fakeInfraFleetClient) ListSshTargets(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest, _ ...grpc.CallOption) (*infrafleetv1.ListSshTargetsResponse, error) {
	return f.listSshTargetsFunc(ctx, in)
}

func (f *fakeInfraFleetClient) Relay(ctx context.Context, in *infrafleetv1.RelayRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
	return f.relayFunc(ctx, in)
}

func (f *fakeInfraFleetClient) ResolveConnection(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest, _ ...grpc.CallOption) (*infrafleetv1.ResolveConnectionResponse, error) {
	return f.resolveConnectionFunc(ctx, in)
}

func (f *fakeInfraFleetClient) RelayByDevServer(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest, _ ...grpc.CallOption) (*infrafleetv1.RelayResponse, error) {
	return f.relayByDevServerFunc(ctx, in)
}

func (f *fakeInfraFleetClient) IsDevServerConnected(ctx context.Context, in *infrafleetv1.IsDevServerConnectedRequest, _ ...grpc.CallOption) (*infrafleetv1.IsDevServerConnectedResponse, error) {
	if f.isDevServerConnectedFunc != nil {
		return f.isDevServerConnectedFunc(ctx, in)
	}
	return &infrafleetv1.IsDevServerConnectedResponse{Connected: false}, nil
}

func (f *fakeInfraFleetClient) ListDevServers(ctx context.Context, in *infrafleetv1.ListDevServersRequest, _ ...grpc.CallOption) (*infrafleetv1.ListDevServersResponse, error) {
	return f.listDevServersFunc(ctx, in)
}

func (f *fakeInfraFleetClient) RegisterDevServer(ctx context.Context, in *infrafleetv1.RegisterDevServerRequest, _ ...grpc.CallOption) (*infrafleetv1.RegisterDevServerResponse, error) {
	return f.registerDevServerFunc(ctx, in)
}

func (f *fakeInfraFleetClient) GetFleetHealth(ctx context.Context, in *infrafleetv1.GetFleetHealthRequest, _ ...grpc.CallOption) (*infrafleetv1.GetFleetHealthResponse, error) {
	return f.getFleetHealthFunc(ctx, in)
}

// outgoingTenantUser reads back the metadata AttachIdentity is expected to
// have stamped onto ctx, so tests can assert it actually ran.
func outgoingTenantUser(ctx context.Context) (tenant, user string) {
	md, ok := metadata.FromOutgoingContext(ctx)
	if !ok {
		return "", ""
	}
	if v := md.Get(grpcmw.MetadataTenantID); len(v) > 0 {
		tenant = v[0]
	}
	if v := md.Get(grpcmw.MetadataUserID); len(v) > 0 {
		user = v[0]
	}
	return tenant, user
}

func argsJSON(t *testing.T, v any) []json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshaling test args: %v", err)
	}
	return []json.RawMessage{raw}
}

func TestDevServerListChannel_Success(t *testing.T) {
	var gotCtx context.Context
	fake := &fakeInfraFleetClient{
		listDevServersFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersRequest) (*infrafleetv1.ListDevServersResponse, error) {
			gotCtx = ctx
			return &infrafleetv1.ListDevServersResponse{
				DevServers: []*infrafleetv1.DevServer{
					{Id: "ds-1", TenantId: "tenant-1", Host: "ws://devserver.local:6799", Mode: infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_WEBSOCKET},
					{Id: "ds-2", TenantId: "tenant-1", Host: "10.0.0.5", Mode: infrafleetv1.ConnectionMode_CONNECTION_MODE_RELAY_SSH},
				},
			}, nil
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "devServer.list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	views, ok := result.([]devServerView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if len(views) != 2 {
		t.Fatalf("want 2 dev servers, got %d", len(views))
	}
	if views[0].ID != "ds-1" || views[0].ConnectionType != "relay-websocket" || views[0].Status != "disconnected" {
		t.Errorf("unexpected first view: %+v", views[0])
	}
	if views[0].WSUrl == nil || *views[0].WSUrl != "ws://devserver.local:6799" {
		t.Errorf("expected WSUrl to carry host, got %+v", views[0].WSUrl)
	}
	if views[1].ConnectionType != "relay-ssh" {
		t.Errorf("want relay-ssh, got %q", views[1].ConnectionType)
	}

	tenant, user := outgoingTenantUser(gotCtx)
	if tenant != "tenant-1" || user != "user-1" {
		t.Errorf("AttachIdentity not applied: tenant=%q user=%q", tenant, user)
	}
}

// TestDevServerListChannel_ReportsRealConnectionStatus is the live-bug
// regression: toDevServerView's Status field was hardcoded to
// "disconnected" always, regardless of whether the agent actually had a
// live session — devServer.list now enriches each row via
// IsDevServerConnected (attachConnectionStatus).
func TestDevServerListChannel_ReportsRealConnectionStatus(t *testing.T) {
	var gotConnectedReq *infrafleetv1.IsDevServerConnectedRequest
	fake := &fakeInfraFleetClient{
		listDevServersFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersRequest) (*infrafleetv1.ListDevServersResponse, error) {
			return &infrafleetv1.ListDevServersResponse{
				DevServers: []*infrafleetv1.DevServer{
					{Id: "ds-1", TenantId: "tenant-1", Host: "dev.example.com", Mode: infrafleetv1.ConnectionMode_CONNECTION_MODE_DIRECT_WEBSOCKET},
				},
			}, nil
		},
		isDevServerConnectedFunc: func(ctx context.Context, in *infrafleetv1.IsDevServerConnectedRequest) (*infrafleetv1.IsDevServerConnectedResponse, error) {
			gotConnectedReq = in
			return &infrafleetv1.IsDevServerConnectedResponse{Connected: true}, nil
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	views := result.([]devServerView)
	if len(views) != 1 || views[0].Status != "connected" {
		t.Errorf("want Status=connected reflecting the agent's real live session, got %+v", views)
	}
	if gotConnectedReq.GetDevServerId() != "ds-1" {
		t.Errorf("want IsDevServerConnected devServerId=ds-1, got %q", gotConnectedReq.GetDevServerId())
	}
}

// TestDevServerListChannel_StatusCheckErrorFailsOpenToDisconnected verifies
// a status-check hiccup degrades to "disconnected" rather than failing the
// whole list.
func TestDevServerListChannel_StatusCheckErrorFailsOpenToDisconnected(t *testing.T) {
	fake := &fakeInfraFleetClient{
		listDevServersFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersRequest) (*infrafleetv1.ListDevServersResponse, error) {
			return &infrafleetv1.ListDevServersResponse{
				DevServers: []*infrafleetv1.DevServer{{Id: "ds-1", TenantId: "tenant-1", Host: "dev.example.com"}},
			}, nil
		},
		isDevServerConnectedFunc: func(ctx context.Context, in *infrafleetv1.IsDevServerConnectedRequest) (*infrafleetv1.IsDevServerConnectedResponse, error) {
			return nil, errors.New("infra-fleet-service unavailable")
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.list", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	views := result.([]devServerView)
	if len(views) != 1 || views[0].Status != "disconnected" {
		t.Errorf("want Status=disconnected (fail-open) when the status check errors, got %+v", views)
	}
}

func TestDevServerListChannel_PropagatesError(t *testing.T) {
	wantErr := errors.New("infra-fleet-service unavailable")
	fake := &fakeInfraFleetClient{
		listDevServersFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersRequest) (*infrafleetv1.ListDevServersResponse, error) {
			return nil, wantErr
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.list", nil)
	if !errors.Is(err, wantErr) {
		t.Fatalf("want error %v, got %v", wantErr, err)
	}
}

func TestDevServerAddChannel_Success(t *testing.T) {
	var gotReq *infrafleetv1.RegisterDevServerRequest
	var gotCtx context.Context
	fake := &fakeInfraFleetClient{
		registerDevServerFunc: func(ctx context.Context, in *infrafleetv1.RegisterDevServerRequest) (*infrafleetv1.RegisterDevServerResponse, error) {
			gotCtx = ctx
			gotReq = in
			return &infrafleetv1.RegisterDevServerResponse{
				DevServer: &infrafleetv1.DevServer{Id: "ds-new", TenantId: in.TenantId, Host: in.Host, Mode: in.Mode},
			}, nil
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	args := argsJSON(t, map[string]any{
		"name":           "MacBook Pro M3",
		"connectionType": "direct-websocket",
		"wsUrl":          "ws://devserver.local:6799",
	})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "devServer.add", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if gotReq.TenantId != "tenant-1" {
		t.Errorf("want tenant-1 in request, got %q", gotReq.TenantId)
	}
	if gotReq.Host != "ws://devserver.local:6799" {
		t.Errorf("want wsUrl to win host precedence, got %q", gotReq.Host)
	}
	if gotReq.Mode != infrafleetv1.ConnectionMode_CONNECTION_MODE_DIRECT_WEBSOCKET {
		t.Errorf("unexpected mode: %v", gotReq.Mode)
	}

	view, ok := result.(devServerView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if view.ID != "ds-new" || view.ConnectionType != "direct-websocket" {
		t.Errorf("unexpected view: %+v", view)
	}

	tenant, user := outgoingTenantUser(gotCtx)
	if tenant != "tenant-1" || user != "user-1" {
		t.Errorf("AttachIdentity not applied: tenant=%q user=%q", tenant, user)
	}
}

func TestDevServerAddChannel_HostPrecedenceFallsBackToNameWhenNoWSUrlOrSSHTarget(t *testing.T) {
	var gotReq *infrafleetv1.RegisterDevServerRequest
	fake := &fakeInfraFleetClient{
		registerDevServerFunc: func(ctx context.Context, in *infrafleetv1.RegisterDevServerRequest) (*infrafleetv1.RegisterDevServerResponse, error) {
			gotReq = in
			return &infrafleetv1.RegisterDevServerResponse{DevServer: &infrafleetv1.DevServer{Id: "ds-x"}}, nil
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	args := argsJSON(t, map[string]any{
		"name":           "fallback-name",
		"connectionType": "relay-ssh",
	})

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.add", args); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.Host != "fallback-name" {
		t.Errorf("want name fallback, got %q", gotReq.Host)
	}
}

func TestDevServerAddChannel_PropagatesError(t *testing.T) {
	wantErr := errors.New("host unreachable")
	fake := &fakeInfraFleetClient{
		registerDevServerFunc: func(ctx context.Context, in *infrafleetv1.RegisterDevServerRequest) (*infrafleetv1.RegisterDevServerResponse, error) {
			return nil, wantErr
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	args := argsJSON(t, map[string]any{"name": "x", "connectionType": "relay-ssh"})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.add", args)
	if !errors.Is(err, wantErr) {
		t.Fatalf("want error %v, got %v", wantErr, err)
	}
}

// TestDevServerListSshTargetsChannel_WrapsAndSynthesizesFields verifies the
// channel wraps results in {targets: [...]} (matching web-preload-api.ts's
// listSshTargets() contract) and synthesizes label/port since backend-go's
// SshTarget proto message doesn't carry them.
func TestDevServerListSshTargetsChannel_WrapsAndSynthesizesFields(t *testing.T) {
	fake := &fakeInfraFleetClient{
		listSshTargetsFunc: func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error) {
			return &infrafleetv1.ListSshTargetsResponse{
				SshTargets: []*infrafleetv1.SshTarget{
					{Id: "t1", Host: "dev.example.com", User: "alice"},
				},
			}, nil
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.listSshTargets", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	targets, ok := m["targets"].([]any)
	if !ok || len(targets) != 1 {
		t.Fatalf("unexpected targets: %v", m["targets"])
	}
	target, ok := targets[0].(map[string]any)
	if !ok {
		t.Fatalf("unexpected target shape: %v", targets[0])
	}
	if target["id"] != "t1" || target["host"] != "dev.example.com" || target["username"] != "alice" {
		t.Errorf("unexpected target fields: %+v", target)
	}
	if target["label"] != "alice@dev.example.com" {
		t.Errorf("want synthesized label 'alice@dev.example.com', got %v", target["label"])
	}
	if target["port"] != float64(22) {
		t.Errorf("want synthesized port 22, got %v", target["port"])
	}
}

// TestDevServerListSshTargetsChannel_ReturnsEmptyArrayNotNull mirrors
// TestRegisterRepoChannels' "empty array, not null" guard for the same
// wrapped-response family.
func TestDevServerListSshTargetsChannel_ReturnsEmptyArrayNotNull(t *testing.T) {
	fake := &fakeInfraFleetClient{
		listSshTargetsFunc: func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error) {
			return &infrafleetv1.ListSshTargetsResponse{}, nil
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{}, "devServer.listSshTargets", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if string(raw) != `{"targets":[]}` {
		t.Errorf(`want {"targets":[]}, got %s`, raw)
	}
}

// TestDevServerBrowseDirChannel_RequiresDevServerID verifies the channel
// fails loudly rather than guessing which dev server to browse.
func TestDevServerBrowseDirChannel_RequiresDevServerID(t *testing.T) {
	r := NewRegistry()
	registerDevServerChannels(r, &fakeInfraFleetClient{})

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.browseDir", argsJSON(t, map[string]any{}))
	if err == nil {
		t.Fatal("expected an error when id is omitted")
	}
}

// TestDevServerBrowseDirChannel_NotConnectedErrors verifies browsing a dev
// server with no live agent session surfaces as an error (unlike
// onboarding.detectAgents, "can't browse right now" has no useful empty
// fallback — the picker can't show anything meaningful).
func TestDevServerBrowseDirChannel_NotConnectedErrors(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			return nil, status.Error(codes.FailedPrecondition, "INFRA_DEV_SERVER_NOT_CONNECTED: this dev server has no live agent connection right now")
		},
	}
	r := NewRegistry()
	registerDevServerChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.browseDir",
		argsJSON(t, map[string]any{"id": "ds-1", "path": "/tmp"}))
	if err == nil {
		t.Fatal("expected an error when the dev server has no live connection")
	}
}

// TestDevServerBrowseDirChannel_DefaultsTildeToRoot is the honest-fallback
// regression: fs.readDir does no `~` expansion, so a caller's default "~"
// (RemoteFileBrowser's initialPath) must not be forwarded verbatim.
func TestDevServerBrowseDirChannel_DefaultsTildeToRoot(t *testing.T) {
	var gotRelayReq *infrafleetv1.RelayByDevServerRequest
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotRelayReq = in
			return &infrafleetv1.RelayResponse{ResultJson: `{"path":"/","entries":[]}`}, nil
		},
	}
	r := NewRegistry()
	registerDevServerChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.browseDir",
		argsJSON(t, map[string]any{"id": "ds-1", "path": "~"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(gotRelayReq.GetParamsJson(), `"path":"/"`) {
		t.Errorf(`want path defaulted to "/", got paramsJson=%q`, gotRelayReq.GetParamsJson())
	}
}

// TestDevServerBrowseDirChannel_RelaysAndMapsEntries is the live bug
// regression: devServer.browseDir never existed on the backend at all, so
// every "Browse host"/"choose parent folder" flow always failed. Verifies
// devServerId is relayed directly (no infra.connections indirection —
// see RelayByDevServer's doc comment), fs.readDir is relayed with depth:1,
// and its {path,entries:[{path,name,type}]} shape is mapped into the
// {resolvedPath,entries:[{name,isDirectory,isSymlink}]} shape
// web-preload-api.ts / RemoteFileBrowser expect.
func TestDevServerBrowseDirChannel_RelaysAndMapsEntries(t *testing.T) {
	var gotRelayReq *infrafleetv1.RelayByDevServerRequest
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotRelayReq = in
			return &infrafleetv1.RelayResponse{ResultJson: `{
				"path": "/home/dev/projects",
				"entries": [
					{"path": "/home/dev/projects/orca", "name": "orca", "type": "directory"},
					{"path": "/home/dev/projects/readme.md", "name": "readme.md", "type": "file"}
				]
			}`}, nil
		},
	}
	r := NewRegistry()
	registerDevServerChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.browseDir",
		argsJSON(t, map[string]any{"id": "ds-1", "path": "/home/dev/projects"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotRelayReq.GetDevServerId() != "ds-1" {
		t.Errorf("want RelayByDevServer devServerId=ds-1, got %q", gotRelayReq.GetDevServerId())
	}
	if gotRelayReq.GetMethod() != "fs.readDir" {
		t.Errorf("want Relay method=fs.readDir, got %q", gotRelayReq.GetMethod())
	}
	if !strings.Contains(gotRelayReq.GetParamsJson(), `"depth":1`) {
		t.Errorf("want depth:1 in paramsJson, got %q", gotRelayReq.GetParamsJson())
	}

	view, ok := result.(devServerBrowseDirResultView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if view.ResolvedPath != "/home/dev/projects" {
		t.Errorf("want ResolvedPath=/home/dev/projects, got %q", view.ResolvedPath)
	}
	if len(view.Entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(view.Entries))
	}
	if view.Entries[0].Name != "orca" || !view.Entries[0].IsDirectory {
		t.Errorf("unexpected entry[0]: %+v", view.Entries[0])
	}
	if view.Entries[1].Name != "readme.md" || view.Entries[1].IsDirectory {
		t.Errorf("unexpected entry[1]: %+v", view.Entries[1])
	}
}

func TestFleetHealthCheckAllChannel_FiltersByRequestedServerIDs(t *testing.T) {
	var gotCtx context.Context
	fake := &fakeInfraFleetClient{
		getFleetHealthFunc: func(ctx context.Context, in *infrafleetv1.GetFleetHealthRequest) (*infrafleetv1.GetFleetHealthResponse, error) {
			gotCtx = ctx
			return &infrafleetv1.GetFleetHealthResponse{
				Statuses: []*infrafleetv1.DevServerHealth{
					{DevServerId: "ds-1", Reachable: true, CpuPercent: 12.5, RamPercent: 40, DiskPercent: 60, LatencyMs: 5},
					{DevServerId: "ds-2", Reachable: false, CpuPercent: 0, RamPercent: 0, DiskPercent: 0, LatencyMs: 0},
					{DevServerId: "ds-3-not-requested", Reachable: true},
				},
			}, nil
		},
	}

	r := NewRegistry()
	registerFleetChannels(r, fake)

	args := argsJSON(t, map[string]any{"serverIds": []string{"ds-1", "ds-2"}})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "fleet.health.checkAll", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	views, ok := result.([]serverHealthView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if len(views) != 2 {
		t.Fatalf("want 2 filtered results (ds-3 excluded), got %d: %+v", len(views), views)
	}
	byID := map[string]serverHealthView{}
	for _, v := range views {
		byID[v.ServerID] = v
	}
	if !byID["ds-1"].IsReachable || byID["ds-1"].CPUUsagePercent != 12.5 {
		t.Errorf("unexpected ds-1 view: %+v", byID["ds-1"])
	}
	if byID["ds-2"].IsReachable {
		t.Errorf("ds-2 should be unreachable: %+v", byID["ds-2"])
	}
	if _, present := byID["ds-3-not-requested"]; present {
		t.Errorf("ds-3-not-requested should have been filtered out")
	}

	tenant, user := outgoingTenantUser(gotCtx)
	if tenant != "tenant-1" || user != "user-1" {
		t.Errorf("AttachIdentity not applied: tenant=%q user=%q", tenant, user)
	}
}

func TestFleetHealthCheckAllChannel_PropagatesError(t *testing.T) {
	wantErr := errors.New("infra-fleet-service unavailable")
	fake := &fakeInfraFleetClient{
		getFleetHealthFunc: func(ctx context.Context, in *infrafleetv1.GetFleetHealthRequest) (*infrafleetv1.GetFleetHealthResponse, error) {
			return nil, wantErr
		},
	}

	r := NewRegistry()
	registerFleetChannels(r, fake)

	args := argsJSON(t, map[string]any{"serverIds": []string{"ds-1"}})
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "fleet.health.checkAll", args)
	if !errors.Is(err, wantErr) {
		t.Fatalf("want error %v, got %v", wantErr, err)
	}
}

// ── TASK-007: crashReports.* tests ──────────────────────────────────────────

// TestCrashReportGetLatestPendingChannel_ReturnsNull verifies that the channel
// returns nil (JSON null) — the honest answer for a backend that has no crash
// reporting service. Frontend expects a nullable result.
func TestCrashReportGetLatestPendingChannel_ReturnsNull(t *testing.T) {
	r := NewRegistry()
	registerCrashReportChannels(r)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "crashReports.getLatestPending", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Errorf("want nil (no crash report in backend-go), got %v", result)
	}
}

// TestCrashReportGetLatestPendingChannel_AcceptsAnyArgs verifies that the
// handler does not panic or error when called with no args or extra args.
func TestCrashReportGetLatestPendingChannel_AcceptsAnyArgs(t *testing.T) {
	r := NewRegistry()
	registerCrashReportChannels(r)

	// no args
	if _, err := r.Dispatch(context.Background(), Identity{}, "crashReports.getLatestPending", nil); err != nil {
		t.Errorf("with nil args: unexpected error: %v", err)
	}
	// extra args (frontend may pass session id etc.)
	args := argsJSON(t, map[string]any{"sessionId": "abc-123"})
	if _, err := r.Dispatch(context.Background(), Identity{}, "crashReports.getLatestPending", args); err != nil {
		t.Errorf("with extra args: unexpected error: %v", err)
	}
}

// ── TASK-007: rateLimits.* tests ─────────────────────────────────────────────

// fakeRateLimitReader is a test double for the rateLimitReader interface.
type fakeRateLimitReader struct {
	rps   float64
	burst int
}

func (f *fakeRateLimitReader) RPS() float64 { return f.rps }
func (f *fakeRateLimitReader) Burst() int   { return f.burst }

// TestApiGatewayRateLimitsGetChannel_ReturnsConfiguredValues verifies the
// channel exposes the limiter's configured RPS and burst — not live
// per-tenant counters. Namespaced under apiGateway.* — see
// registerRateLimitChannels's doc comment for why this isn't "rateLimits.get".
func TestApiGatewayRateLimitsGetChannel_ReturnsConfiguredValues(t *testing.T) {
	r := NewRegistry()
	rl := &fakeRateLimitReader{rps: 100.0, burst: 200}
	registerRateLimitChannels(r, rl)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "apiGateway.rateLimits.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	info, ok := result.(rateLimitInfo)
	if !ok {
		t.Fatalf("unexpected result type %T, want rateLimitInfo", result)
	}
	if info.RequestsPerSecond != 100.0 {
		t.Errorf("want RequestsPerSecond=100.0, got %f", info.RequestsPerSecond)
	}
	if info.Burst != 200 {
		t.Errorf("want Burst=200, got %d", info.Burst)
	}
}

// TestApiGatewayRateLimitsGetChannel_JSONFieldNames verifies the JSON wire
// format has the field names the frontend expects (camelCase).
func TestApiGatewayRateLimitsGetChannel_JSONFieldNames(t *testing.T) {
	r := NewRegistry()
	rl := &fakeRateLimitReader{rps: 10.0, burst: 20}
	registerRateLimitChannels(r, rl)

	result, err := r.Dispatch(context.Background(), Identity{}, "apiGateway.rateLimits.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if _, ok := m["requestsPerSecond"]; !ok {
		t.Errorf("JSON field 'requestsPerSecond' missing; got keys: %v", m)
	}
	if _, ok := m["burst"]; !ok {
		t.Errorf("JSON field 'burst' missing; got keys: %v", m)
	}
}

// TestRateLimitsGetChannel_ReturnsHonestProviderDefaults guards the exact
// bug this rename fixed: rateLimits.get must answer the frontend's real
// AI-provider-usage contract (RateLimitState) with every provider explicitly
// null, not the gateway-throttle shape whose missing provider keys crashed
// StatusBar (status-bar-provider-visibility.ts's isProviderConfigured reads
// `.status` off what JSON decodes as undefined for a key that's absent).
func TestRateLimitsGetChannel_ReturnsHonestProviderDefaults(t *testing.T) {
	r := NewRegistry()
	registerRateLimitChannels(r, &fakeRateLimitReader{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "rateLimits.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	for _, key := range []string{
		"claude", "codex", "gemini", "opencodeGo", "kimi", "antigravity", "minimax", "grok",
	} {
		v, ok := m[key]
		if !ok {
			t.Errorf("JSON field %q missing; got keys: %v", key, m)
			continue
		}
		if v != nil {
			t.Errorf("want %q explicitly null, got %v", key, v)
		}
	}
	for _, key := range []string{
		"minimaxCookieConfigured", "grokAuthConfigured", "claudeTarget", "codexTarget",
		"inactiveClaudeAccounts", "inactiveCodexAccounts",
	} {
		if _, ok := m[key]; !ok {
			t.Errorf("JSON field %q missing; got keys: %v", key, m)
		}
	}
	inactiveClaude, ok := m["inactiveClaudeAccounts"].([]any)
	if !ok || len(inactiveClaude) != 0 {
		t.Errorf("want inactiveClaudeAccounts=[], got %v", m["inactiveClaudeAccounts"])
	}
}

// ── telemetry.* tests ────────────────────────────────────────────────────────

// TestTelemetryTrackChannel_NoOpsWithoutError verifies telemetry.track
// accepts a real {name, props} payload and returns success without
// erroring — no analytics backend exists yet, this is the honest interim
// no-op (see channels_telemetry.go's doc comment).
func TestTelemetryTrackChannel_NoOpsWithoutError(t *testing.T) {
	r := NewRegistry()
	registerTelemetryChannels(r)

	args := argsJSON(t, map[string]any{"name": "onboarding_step_completed", "props": map[string]any{"step": 2}})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "telemetry.track", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Errorf("want nil result, got %v", result)
	}
}

// TestTelemetryTrackChannel_AcceptsNoArgs verifies the handler tolerates a
// missing args array too — it never decodes args at all.
func TestTelemetryTrackChannel_AcceptsNoArgs(t *testing.T) {
	r := NewRegistry()
	registerTelemetryChannels(r)

	if _, err := r.Dispatch(context.Background(), Identity{}, "telemetry.track", nil); err != nil {
		t.Errorf("with nil args: unexpected error: %v", err)
	}
}

// ── onboarding.* tests ───────────────────────────────────────────────────────

// TestOnboardingGetChannel_ReturnsNotStartedDefaults verifies the channel
// returns the same "wizard not started" defaults the old TS backend's
// getDefaultOnboardingState() did — the honest answer given backend-go has
// no per-installation onboarding-progress store yet.
func TestOnboardingGetChannel_ReturnsNotStartedDefaults(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, nil, nil)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	state, ok := result.(onboardingStateView)
	if !ok {
		t.Fatalf("unexpected result type %T, want onboardingStateView", result)
	}
	if state.FlowVersion != onboardingFlowVersion {
		t.Errorf("want FlowVersion=%d, got %d", onboardingFlowVersion, state.FlowVersion)
	}
	if state.LastCompletedStep != -1 {
		t.Errorf("want LastCompletedStep=-1 (not started), got %d", state.LastCompletedStep)
	}
	if state.ClosedAt != nil {
		t.Errorf("want ClosedAt=nil, got %v", *state.ClosedAt)
	}
	if state.Outcome != nil {
		t.Errorf("want Outcome=nil, got %v", *state.Outcome)
	}
	if state.Checklist.Dismissed {
		t.Errorf("want checklist.dismissed=false by default")
	}
}

// TestOnboardingGetChannel_JSONFieldNames verifies the JSON wire format
// matches frontend/src/shared/types.ts's OnboardingState field names.
func TestOnboardingGetChannel_JSONFieldNames(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, nil, nil)

	result, err := r.Dispatch(context.Background(), Identity{}, "onboarding.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}

	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	for _, key := range []string{"flowVersion", "closedAt", "outcome", "lastCompletedStep", "checklist"} {
		if _, ok := m[key]; !ok {
			t.Errorf("JSON field %q missing; got keys: %v", key, m)
		}
	}
	checklist, ok := m["checklist"].(map[string]any)
	if !ok {
		t.Fatalf("checklist field is not an object: %v", m["checklist"])
	}
	for _, key := range []string{
		"addedRepo", "choseAgent", "ranFirstAgent", "ranSecondAgentOnSameTask",
		"triedCmdJ", "shapedSidebar", "reviewedDiff", "openedPr", "addedFolder",
		"openedFile", "ranAgentOnFile", "dismissed",
	} {
		if _, ok := checklist[key]; !ok {
			t.Errorf("JSON checklist field %q missing; got keys: %v", key, checklist)
		}
	}
}

// TestOnboardingGetChannel_AcceptsAnyArgs verifies the handler does not
// panic or error when called with no args (the frontend calls onboarding.get
// with none) or with extra args.
func TestOnboardingGetChannel_AcceptsAnyArgs(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, nil, nil)

	if _, err := r.Dispatch(context.Background(), Identity{}, "onboarding.get", nil); err != nil {
		t.Errorf("with nil args: unexpected error: %v", err)
	}
	args := argsJSON(t, map[string]any{"unexpected": "arg"})
	if _, err := r.Dispatch(context.Background(), Identity{}, "onboarding.get", args); err != nil {
		t.Errorf("with extra args: unexpected error: %v", err)
	}
}

// TestOnboardingUpdateChannel_EchoesDismissedOutcome guards the exact bug
// this handler fixed: use-onboarding-flow-persistence.ts's closeWith() awaits
// onboarding.update and only closes the onboarding modal if it resolves — a
// missing/erroring handler here means Skip silently does nothing.
func TestOnboardingUpdateChannel_EchoesDismissedOutcome(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, nil, nil)

	args := argsJSON(t, map[string]any{
		"flowVersion":       4,
		"closedAt":          1700000000000,
		"outcome":           "dismissed",
		"lastCompletedStep": -1,
		"checklist":         map[string]any{"dismissed": true},
	})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.update", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	state, ok := result.(onboardingStateView)
	if !ok {
		t.Fatalf("unexpected result type %T, want onboardingStateView", result)
	}
	if state.Outcome == nil || *state.Outcome != "dismissed" {
		t.Errorf("want Outcome=\"dismissed\", got %v", state.Outcome)
	}
	if state.ClosedAt == nil || *state.ClosedAt != 1700000000000 {
		t.Errorf("want ClosedAt=1700000000000, got %v", state.ClosedAt)
	}
	if !state.Checklist.Dismissed {
		t.Errorf("want checklist.dismissed=true")
	}
}

// TestOnboardingUpdateChannel_DefaultsOmittedFields verifies fields the
// caller doesn't send fall back to onboarding.get's same defaults, not to
// Go zero values that would misrepresent "not started" as "step 0".
func TestOnboardingUpdateChannel_DefaultsOmittedFields(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, nil, nil)

	args := argsJSON(t, map[string]any{"outcome": "completed"})
	result, err := r.Dispatch(context.Background(), Identity{}, "onboarding.update", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	state, ok := result.(onboardingStateView)
	if !ok {
		t.Fatalf("unexpected result type %T, want onboardingStateView", result)
	}
	if state.FlowVersion != onboardingFlowVersion {
		t.Errorf("want FlowVersion=%d, got %d", onboardingFlowVersion, state.FlowVersion)
	}
	if state.LastCompletedStep != -1 {
		t.Errorf("want LastCompletedStep=-1 (default), got %d", state.LastCompletedStep)
	}
}

// TestOnboardingMarkChecklistItemChannel_ReturnsMarkedTrue verifies the
// handler acknowledges instead of erroring even with no tenantClient
// configured (loadOnboardingState/saveOnboardingState's fail-open
// contract — see their doc comments).
func TestOnboardingMarkChecklistItemChannel_ReturnsMarkedTrue(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, nil, nil)

	args := argsJSON(t, map[string]any{"item": "addedRepo", "value": true})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.markChecklistItem", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m, ok := result.(map[string]any)
	if !ok || m["marked"] != true {
		t.Errorf("want {marked: true}, got %v", result)
	}
}

// TestOnboardingGetChannel_NoSavedStateReturnsDefaults verifies a
// configured tenantClient with nothing saved for this user still returns
// the "wizard not started" defaults, not an error.
func TestOnboardingGetChannel_NoSavedStateReturnsDefaults(t *testing.T) {
	tenantFake := &fakeTenantServiceClient2{onboardingStateByUser: map[string]string{}}
	r := NewRegistry()
	registerOnboardingChannels(r, nil, tenantFake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "onboarding.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	state, ok := result.(onboardingStateView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if state.LastCompletedStep != -1 {
		t.Errorf("want LastCompletedStep=-1 (default), got %d", state.LastCompletedStep)
	}
}

// TestOnboardingUpdateChannel_PersistsAcrossGet is the live-bug regression:
// onboarding.update never persisted anything, so a subsequent onboarding.get
// (simulating a page reload) always saw the wizard-not-started defaults
// regardless of how far the user had actually gotten, re-showing onboarding
// forever.
func TestOnboardingUpdateChannel_PersistsAcrossGet(t *testing.T) {
	tenantFake := &fakeTenantServiceClient2{onboardingStateByUser: map[string]string{}}
	r := NewRegistry()
	registerOnboardingChannels(r, nil, tenantFake)
	id := Identity{TenantID: "tenant-1", UserID: "user-1"}

	step := 2
	outcome := "completed"
	updateArgs := argsJSON(t, map[string]any{"lastCompletedStep": step, "outcome": outcome})
	if _, err := r.Dispatch(context.Background(), id, "onboarding.update", updateArgs); err != nil {
		t.Fatalf("unexpected error on update: %v", err)
	}

	result, err := r.Dispatch(context.Background(), id, "onboarding.get", nil)
	if err != nil {
		t.Fatalf("unexpected error on get: %v", err)
	}
	state, ok := result.(onboardingStateView)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if state.LastCompletedStep != step {
		t.Errorf("want LastCompletedStep=%d to survive the round trip, got %d", step, state.LastCompletedStep)
	}
	if state.Outcome == nil || *state.Outcome != outcome {
		t.Errorf("want Outcome=%q to survive the round trip, got %v", outcome, state.Outcome)
	}
}

// TestOnboardingUpdateChannel_ScopesStateByUser verifies two different
// users' onboarding progress don't leak into each other.
func TestOnboardingUpdateChannel_ScopesStateByUser(t *testing.T) {
	tenantFake := &fakeTenantServiceClient2{onboardingStateByUser: map[string]string{}}
	r := NewRegistry()
	registerOnboardingChannels(r, nil, tenantFake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "onboarding.update",
		argsJSON(t, map[string]any{"lastCompletedStep": 3})); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-2"}, "onboarding.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	state := result.(onboardingStateView)
	if state.LastCompletedStep != -1 {
		t.Errorf("want user-2 to see the not-started default, got LastCompletedStep=%d (leaked from user-1)", state.LastCompletedStep)
	}
}

// TestOnboardingMarkChecklistItemChannel_PersistsWithoutClobberingOtherFields
// verifies marking one checklist item persists it and doesn't wipe out
// unrelated state already saved (e.g. lastCompletedStep from an earlier
// onboarding.update).
func TestOnboardingMarkChecklistItemChannel_PersistsWithoutClobberingOtherFields(t *testing.T) {
	tenantFake := &fakeTenantServiceClient2{onboardingStateByUser: map[string]string{}}
	r := NewRegistry()
	registerOnboardingChannels(r, nil, tenantFake)
	id := Identity{TenantID: "tenant-1", UserID: "user-1"}

	if _, err := r.Dispatch(context.Background(), id, "onboarding.update",
		argsJSON(t, map[string]any{"lastCompletedStep": 3})); err != nil {
		t.Fatalf("unexpected error on update: %v", err)
	}
	if _, err := r.Dispatch(context.Background(), id, "onboarding.markChecklistItem",
		argsJSON(t, map[string]any{"item": "addedRepo", "value": true})); err != nil {
		t.Fatalf("unexpected error on markChecklistItem: %v", err)
	}

	result, err := r.Dispatch(context.Background(), id, "onboarding.get", nil)
	if err != nil {
		t.Fatalf("unexpected error on get: %v", err)
	}
	state := result.(onboardingStateView)
	if state.LastCompletedStep != 3 {
		t.Errorf("want LastCompletedStep=3 preserved, got %d", state.LastCompletedStep)
	}
	if !state.Checklist.AddedRepo {
		t.Error("want Checklist.AddedRepo=true after marking it")
	}
}

// TestOnboardingDetectAgentsChannel_RequiresDevServerID verifies the
// channel fails loudly rather than guessing which dev server to probe.
func TestOnboardingDetectAgentsChannel_RequiresDevServerID(t *testing.T) {
	r := NewRegistry()
	registerOnboardingChannels(r, &fakeInfraFleetClient{}, nil)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.detectAgents", argsJSON(t, map[string]any{}))
	if err == nil {
		t.Fatal("expected an error when devServerId is omitted")
	}
}

// TestOnboardingDetectAgentsChannel_NotConnectedReturnsEmpty verifies "no
// live connection right now" is treated as a legitimate onboarding state
// (agent not connected yet), not an error — mirrors
// registerAccountsResolveDevServerConnectionChannel's same convention.
func TestOnboardingDetectAgentsChannel_NotConnectedReturnsEmpty(t *testing.T) {
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			return nil, status.Error(codes.FailedPrecondition, "INFRA_DEV_SERVER_NOT_CONNECTED: this dev server has no live agent connection right now")
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.detectAgents",
		argsJSON(t, map[string]any{"devServerId": "ds-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	view, ok := result.(onboardingDetectAgentsResult)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if len(view.Agents) != 0 {
		t.Errorf("want no agents when not connected, got %v", view.Agents)
	}
}

// TestOnboardingDetectAgentsChannel_RelaysToConnectedDevServer is the live
// bug regression: the web build has no paired Electron runtime environment,
// so the "No agents detected on your PATH" banner always fired regardless
// of the selected dev server. This asserts devServerId is relayed directly
// (no infra.connections indirection — see RelayByDevServer's doc comment),
// commands are passed through to the agent's real preflight.detectAgents
// RPC, and the relay's JSON result is decoded back.
func TestOnboardingDetectAgentsChannel_RelaysToConnectedDevServer(t *testing.T) {
	var gotRelayReq *infrafleetv1.RelayByDevServerRequest
	fake := &fakeInfraFleetClient{
		relayByDevServerFunc: func(ctx context.Context, in *infrafleetv1.RelayByDevServerRequest) (*infrafleetv1.RelayResponse, error) {
			gotRelayReq = in
			return &infrafleetv1.RelayResponse{ResultJson: `{"agents":["claude","codex"],"platform":"linux"}`}, nil
		},
	}
	r := NewRegistry()
	registerOnboardingChannels(r, fake, nil)

	args := argsJSON(t, map[string]any{
		"devServerId": "ds-1",
		"commands":    []map[string]any{{"id": "claude", "cmd": "claude"}},
	})
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "onboarding.detectAgents", args)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotRelayReq.GetDevServerId() != "ds-1" {
		t.Errorf("want RelayByDevServer devServerId=ds-1, got %q", gotRelayReq.GetDevServerId())
	}
	if gotRelayReq.GetMethod() != "preflight.detectAgents" {
		t.Errorf("want Relay method=preflight.detectAgents, got %q", gotRelayReq.GetMethod())
	}
	if !strings.Contains(gotRelayReq.GetParamsJson(), `"claude"`) {
		t.Errorf("want commands passed through in paramsJson, got %q", gotRelayReq.GetParamsJson())
	}
	view, ok := result.(onboardingDetectAgentsResult)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}
	if len(view.Agents) != 2 || view.Agents[0] != "claude" || view.Agents[1] != "codex" {
		t.Errorf("unexpected agents: %v", view.Agents)
	}
	if view.DevServerID != "ds-1" {
		t.Errorf("want DevServerID echoed back as ds-1, got %q", view.DevServerID)
	}
}

// ── TASK-009: rpcTimeout tests ───────────────────────────────────────────────

// TestRPCTimeoutConstant_ShorterThanInvokeTimeout documents the required
// relationship: rpcTimeout < invokeTimeout. Failing this test means the
// per-RPC deadline no longer leaves margin for write-back (SOL-001 / TASK-001).
func TestRPCTimeoutConstant_ShorterThanInvokeTimeout(t *testing.T) {
	if rpcTimeout >= invokeTimeout {
		t.Errorf("rpcTimeout (%s) must be < invokeTimeout (%s); "+
			"rpcTimeout occupies the dispatch window, invokeTimeout must envelope it",
			rpcTimeout, invokeTimeout)
	}
	// Write margin must be at least 5s (writeTimeout from SOL-001).
	margin := invokeTimeout - rpcTimeout
	if margin < 5*time.Second {
		t.Errorf("write margin (invokeTimeout - rpcTimeout = %s) must be >= 5s "+
			"to accommodate writeTimeout (SOL-001)", margin)
	}
}

// TestDevServerListChannel_FailsFastWhenServiceSlow verifies that devServer.list
// returns an error within rpcTimeout + small margin when infra-fleet-service
// blocks, NOT after the full invokeTimeout (25s). Regression guard for BUG-003.
func TestDevServerListChannel_FailsFastWhenServiceSlow(t *testing.T) {
	fake := &fakeInfraFleetClient{
		listDevServersFunc: func(ctx context.Context, in *infrafleetv1.ListDevServersRequest) (*infrafleetv1.ListDevServersResponse, error) {
			// Simulate a slow/hung service: block until the per-RPC context
			// is cancelled (i.e. until rpcTimeout fires).
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	start := time.Now()
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.list", nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want error from slow service, got nil")
	}
	// Must fail within rpcTimeout (8s) + 2s margin, not after 25s.
	maxAllowed := rpcTimeout + 2*time.Second
	if elapsed > maxAllowed {
		t.Errorf("devServer.list took %s, want < %s (rpcTimeout + margin); "+
			"infra-fleet-service timeout not being enforced", elapsed, maxAllowed)
	}
}

// TestDevServerAddChannel_FailsFastWhenServiceSlow verifies the same rpcTimeout
// enforcement for devServer.add.
func TestDevServerAddChannel_FailsFastWhenServiceSlow(t *testing.T) {
	fake := &fakeInfraFleetClient{
		registerDevServerFunc: func(ctx context.Context, in *infrafleetv1.RegisterDevServerRequest) (*infrafleetv1.RegisterDevServerResponse, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}

	r := NewRegistry()
	registerDevServerChannels(r, fake)

	args := argsJSON(t, map[string]any{"name": "slow-server", "connectionType": "relay-ssh"})

	start := time.Now()
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "devServer.add", args)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want error from slow service, got nil")
	}
	if elapsed > rpcTimeout+2*time.Second {
		t.Errorf("devServer.add took %s, want < %s", elapsed, rpcTimeout+2*time.Second)
	}
}

// TestFleetHealthCheckAll_FailsFastWhenServiceSlow verifies rpcTimeout
// enforcement for fleet.health.checkAll.
func TestFleetHealthCheckAll_FailsFastWhenServiceSlow(t *testing.T) {
	fake := &fakeInfraFleetClient{
		getFleetHealthFunc: func(ctx context.Context, in *infrafleetv1.GetFleetHealthRequest) (*infrafleetv1.GetFleetHealthResponse, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}

	r := NewRegistry()
	registerFleetChannels(r, fake)

	args := argsJSON(t, map[string]any{"serverIds": []string{"ds-1"}})

	start := time.Now()
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "fleet.health.checkAll", args)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("want error from slow service, got nil")
	}
	if elapsed > rpcTimeout+2*time.Second {
		t.Errorf("fleet.health.checkAll took %s, want < %s", elapsed, rpcTimeout+2*time.Second)
	}
}

// ── TASK-010: preflight.check tests ─────────────────────────────────────────

// TestPreflightCheckChannel_CompletesInstantly verifies that preflight.check
// returns within 50ms — it makes no downstream calls and should be sub-millisecond
// in practice. Regression guard for BUG-004.
func TestPreflightCheckChannel_CompletesInstantly(t *testing.T) {
	r := NewRegistry()
	registerPreflightChannels(r)

	start := time.Now()
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1"}, "preflight.check", nil)
	elapsed := time.Since(start)

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if elapsed > 50*time.Millisecond {
		t.Errorf("preflight.check took %s, want < 50ms (local handler, no gRPC call)", elapsed)
	}

	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T, want map[string]any", result)
	}

	// Verify git key exists and installed=true (git-gateway-service uses real git binary).
	gitInfo, ok := m["git"].(map[string]any)
	if !ok {
		t.Fatalf("result['git'] is %T, want map[string]any", m["git"])
	}
	if gitInfo["installed"] != true {
		t.Errorf("result['git']['installed'] = %v, want true", gitInfo["installed"])
	}

	// Verify gh and glab report installed=false (no CLI wrappers in backend-go).
	for _, tool := range []string{"gh", "glab"} {
		info, ok := m[tool].(map[string]any)
		if !ok {
			t.Fatalf("result[%q] is %T, want map[string]any", tool, m[tool])
		}
		if info["installed"] != false {
			t.Errorf("result[%q]['installed'] = %v, want false (no CLI in backend-go)", tool, info["installed"])
		}
		if info["authenticated"] != false {
			t.Errorf("result[%q]['authenticated'] = %v, want false", tool, info["authenticated"])
		}
	}
}

// TestPreflightCheckChannel_ReturnsExpectedKeys verifies the response has
// exactly the keys the frontend expects (git, gh, glab).
func TestPreflightCheckChannel_ReturnsExpectedKeys(t *testing.T) {
	r := NewRegistry()
	registerPreflightChannels(r)

	result, err := r.Dispatch(context.Background(), Identity{}, "preflight.check", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	m, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", result)
	}

	for _, key := range []string{"git", "gh", "glab"} {
		if _, exists := m[key]; !exists {
			t.Errorf("preflight.check response missing expected key %q", key)
		}
	}
}
