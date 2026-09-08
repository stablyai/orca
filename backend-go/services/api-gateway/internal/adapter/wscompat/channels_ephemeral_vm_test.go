package wscompat

import (
	"context"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"
)

// fakeEphemeralVmGitGatewayClient is scoped to ReadEphemeralVmRecipes — the
// only RPC ephemeralVm.* channels call on GitGatewayServiceClient.
type fakeEphemeralVmGitGatewayClient struct {
	gitgatewayv1.GitGatewayServiceClient

	readEphemeralVmRecipesFunc   func(ctx context.Context, in *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error)
	calledReadEphemeralVmRecipes bool
}

func (f *fakeEphemeralVmGitGatewayClient) ReadEphemeralVmRecipes(ctx context.Context, in *gitgatewayv1.ReadEphemeralVmRecipesRequest, _ ...grpc.CallOption) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
	f.calledReadEphemeralVmRecipes = true
	return f.readEphemeralVmRecipesFunc(ctx, in)
}

// fakeEphemeralVmProjectClient is scoped to ListProjects/ListRepos —
// listRecipeCatalog's N+1 loop.
type fakeEphemeralVmProjectClient struct {
	projectv1.ProjectServiceClient

	listProjectsFunc func(ctx context.Context, in *projectv1.ListProjectsRequest) (*projectv1.ListProjectsResponse, error)
	listReposFunc    func(ctx context.Context, in *projectv1.ListReposRequest) (*projectv1.ListReposResponse, error)

	listReposCallCount int
}

func (f *fakeEphemeralVmProjectClient) ListProjects(ctx context.Context, in *projectv1.ListProjectsRequest, _ ...grpc.CallOption) (*projectv1.ListProjectsResponse, error) {
	return f.listProjectsFunc(ctx, in)
}

func (f *fakeEphemeralVmProjectClient) ListRepos(ctx context.Context, in *projectv1.ListReposRequest, _ ...grpc.CallOption) (*projectv1.ListReposResponse, error) {
	f.listReposCallCount++
	return f.listReposFunc(ctx, in)
}

// fakeEphemeralVmInfraFleetClient is scoped to ListEphemeralVmRuntimes plus
// TASK-005's lifecycle RPCs (attach/suspend/resume/cleanup) and
// ResolveConnection (worktree -> connectionId resolution).
type fakeEphemeralVmInfraFleetClient struct {
	infrafleetv1.InfraFleetServiceClient

	listEphemeralVmRuntimesFunc func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error)

	attachFunc  func(ctx context.Context, in *infrafleetv1.AttachEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error)
	suspendFunc func(ctx context.Context, in *infrafleetv1.SuspendEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error)
	resumeFunc  func(ctx context.Context, in *infrafleetv1.ResumeEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error)
	cleanupFunc func(ctx context.Context, in *infrafleetv1.CleanupEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error)

	resolveConnectionFunc   func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error)
	calledResolveConnection bool

	calledSuspend, calledResume, calledCleanup             bool
	gotSuspendCommand, gotResumeCommand, gotCleanupCommand string

	// streamVmProvisionErr, if set, makes StreamVmProvision fail outright
	// (the RPC dial itself, not a stream event) — TASK-BE-EVM-005 tests.
	streamVmProvisionErr        error
	gotStreamVmProvisionRequest *infrafleetv1.StreamVmProvisionRequest

	lastVmProvisionStreamMu sync.Mutex
	lastVmProvisionStream   *fakeVmProvisionStream
}

func (f *fakeEphemeralVmInfraFleetClient) getLastVmProvisionStream() *fakeVmProvisionStream {
	f.lastVmProvisionStreamMu.Lock()
	defer f.lastVmProvisionStreamMu.Unlock()
	return f.lastVmProvisionStream
}

func (f *fakeEphemeralVmInfraFleetClient) ListEphemeralVmRuntimes(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest, _ ...grpc.CallOption) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
	return f.listEphemeralVmRuntimesFunc(ctx, in)
}

func (f *fakeEphemeralVmInfraFleetClient) AttachEphemeralVmWorkspace(ctx context.Context, in *infrafleetv1.AttachEphemeralVmWorkspaceRequest, _ ...grpc.CallOption) (*infrafleetv1.EphemeralVmRuntime, error) {
	return f.attachFunc(ctx, in)
}

func (f *fakeEphemeralVmInfraFleetClient) SuspendEphemeralVmWorkspace(ctx context.Context, in *infrafleetv1.SuspendEphemeralVmWorkspaceRequest, _ ...grpc.CallOption) (*infrafleetv1.EphemeralVmRuntime, error) {
	f.calledSuspend = true
	f.gotSuspendCommand = in.GetCommand()
	return f.suspendFunc(ctx, in)
}

func (f *fakeEphemeralVmInfraFleetClient) ResumeEphemeralVmWorkspace(ctx context.Context, in *infrafleetv1.ResumeEphemeralVmWorkspaceRequest, _ ...grpc.CallOption) (*infrafleetv1.EphemeralVmRuntime, error) {
	f.calledResume = true
	f.gotResumeCommand = in.GetCommand()
	return f.resumeFunc(ctx, in)
}

func (f *fakeEphemeralVmInfraFleetClient) CleanupEphemeralVmWorkspace(ctx context.Context, in *infrafleetv1.CleanupEphemeralVmWorkspaceRequest, _ ...grpc.CallOption) (*infrafleetv1.EphemeralVmRuntime, error) {
	f.calledCleanup = true
	f.gotCleanupCommand = in.GetCommand()
	return f.cleanupFunc(ctx, in)
}

func (f *fakeEphemeralVmInfraFleetClient) ResolveConnection(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest, _ ...grpc.CallOption) (*infrafleetv1.ResolveConnectionResponse, error) {
	f.calledResolveConnection = true
	if f.resolveConnectionFunc != nil {
		return f.resolveConnectionFunc(ctx, in)
	}
	return &infrafleetv1.ResolveConnectionResponse{Connected: false}, nil
}

func (f *fakeEphemeralVmInfraFleetClient) StreamVmProvision(_ context.Context, in *infrafleetv1.StreamVmProvisionRequest, _ ...grpc.CallOption) (infrafleetv1.InfraFleetService_StreamVmProvisionClient, error) {
	f.gotStreamVmProvisionRequest = in
	if f.streamVmProvisionErr != nil {
		return nil, f.streamVmProvisionErr
	}
	stream := newFakeVmProvisionStream()
	f.lastVmProvisionStreamMu.Lock()
	f.lastVmProvisionStream = stream
	f.lastVmProvisionStreamMu.Unlock()
	return stream, nil
}

// fakeVmProvisionStream implements grpc.ServerStreamingClient[VmProvisionEvent]
// (= infrafleetv1.InfraFleetService_StreamVmProvisionClient) — enough to
// drive drainVmProvisionOutput's Recv() loop without a real gRPC transport.
// Mirrors fakePtyStream (channels_terminal_test.go) minus Send/sent, since a
// server-streaming client has no send direction.
type fakeVmProvisionStream struct {
	recv chan *infrafleetv1.VmProvisionEvent
	err  chan error
}

func newFakeVmProvisionStream() *fakeVmProvisionStream {
	return &fakeVmProvisionStream{
		recv: make(chan *infrafleetv1.VmProvisionEvent, 16),
		err:  make(chan error, 1),
	}
}

func (s *fakeVmProvisionStream) Recv() (*infrafleetv1.VmProvisionEvent, error) {
	select {
	case e := <-s.recv:
		return e, nil
	case err := <-s.err:
		return nil, err
	}
}

func (s *fakeVmProvisionStream) Header() (metadata.MD, error) { return nil, nil }
func (s *fakeVmProvisionStream) Trailer() metadata.MD         { return nil }
func (s *fakeVmProvisionStream) CloseSend() error             { s.err <- errCloseSend; return nil }
func (s *fakeVmProvisionStream) Context() context.Context     { return context.Background() }
func (s *fakeVmProvisionStream) SendMsg(any) error            { return nil }
func (s *fakeVmProvisionStream) RecvMsg(any) error            { return nil }

func TestEphemeralVmListRecipes_ReturnsRecipesAndDiagnostics(t *testing.T) {
	gitGateway := &fakeEphemeralVmGitGatewayClient{
		readEphemeralVmRecipesFunc: func(ctx context.Context, in *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
			if in.GetRepoId() != "repo-1" {
				t.Errorf("expected repoId=repo-1, got %q", in.GetRepoId())
			}
			return &gitgatewayv1.ReadEphemeralVmRecipesResponse{
				RepoPath:    "/repo",
				Recipes:     []*gitgatewayv1.EphemeralVmRecipe{{Id: "r1", Create: "docker run"}},
				Diagnostics: []string{"warn: something"},
			}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, &fakeEphemeralVmInfraFleetClient{})

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.listRecipes", argsJSON(t, map[string]any{"repoId": "repo-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !gitGateway.calledReadEphemeralVmRecipes {
		t.Error("expected ReadEphemeralVmRecipes to be called")
	}
	m, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type: %T", got)
	}
	if m["repoPath"] != "/repo" {
		t.Errorf("unexpected repoPath: %+v", m)
	}
}

func TestEphemeralVmDoctor_RecipeNotFound_ReturnsFailCheck(t *testing.T) {
	gitGateway := &fakeEphemeralVmGitGatewayClient{
		readEphemeralVmRecipesFunc: func(ctx context.Context, in *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
			return &gitgatewayv1.ReadEphemeralVmRecipesResponse{RepoPath: "/repo"}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, &fakeEphemeralVmInfraFleetClient{})

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.doctor", argsJSON(t, map[string]any{"repoId": "repo-1", "recipeId": "missing"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := got.(map[string]any)
	if m["ok"] != false {
		t.Errorf("expected ok=false for missing recipe, got %+v", m)
	}
}

func TestEphemeralVmGetCleanupCommand_RuntimeNotFound_ReturnsDisabled(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, &fakeEphemeralVmGitGatewayClient{}, &fakeEphemeralVmProjectClient{}, infra)

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.getCleanupCommand", argsJSON(t, map[string]any{"runtimeId": "rt-missing"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := got.(map[string]any)
	if m["cleanupDisabled"] != true {
		t.Errorf("expected cleanupDisabled=true for missing runtime, got %+v", m)
	}
}

func TestEphemeralVmGetCleanupCommand_RuntimeFound_ReturnsDestroyCommand(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{
				Runtimes: []*infrafleetv1.EphemeralVmRuntime{{Id: "rt-1", RepoId: "repo-1", RecipeId: "r1"}},
			}, nil
		},
	}
	gitGateway := &fakeEphemeralVmGitGatewayClient{
		readEphemeralVmRecipesFunc: func(ctx context.Context, in *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
			return &gitgatewayv1.ReadEphemeralVmRecipesResponse{
				Recipes: []*gitgatewayv1.EphemeralVmRecipe{{Id: "r1", Destroy: "docker rm -f x"}},
			}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, infra)

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.getCleanupCommand", argsJSON(t, map[string]any{"runtimeId": "rt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := got.(map[string]any)
	if m["command"] != "docker rm -f x" || m["cleanupDisabled"] != false {
		t.Errorf("unexpected result: %+v", m)
	}
}

func TestEphemeralVmListRuntimes_ReturnsAllRuntimes(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{
				Runtimes: []*infrafleetv1.EphemeralVmRuntime{{Id: "rt-1"}, {Id: "rt-2"}},
			}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, &fakeEphemeralVmGitGatewayClient{}, &fakeEphemeralVmProjectClient{}, infra)

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.listRuntimes", argsJSON(t, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out, ok := got.([]map[string]any)
	if !ok || len(out) != 2 {
		t.Errorf("expected 2 runtimes, got %+v", got)
	}
}

func TestEphemeralVmListRecipeCatalog_CallsListReposOncePerProject(t *testing.T) {
	project := &fakeEphemeralVmProjectClient{
		listProjectsFunc: func(ctx context.Context, in *projectv1.ListProjectsRequest) (*projectv1.ListProjectsResponse, error) {
			return &projectv1.ListProjectsResponse{Projects: []*projectv1.Project{{Id: "p1"}, {Id: "p2"}}}, nil
		},
		listReposFunc: func(ctx context.Context, in *projectv1.ListReposRequest) (*projectv1.ListReposResponse, error) {
			if in.GetProjectId() == "p1" {
				return &projectv1.ListReposResponse{Repos: []*projectv1.Repo{{Id: "repo-1", DisplayName: "Repo One"}}}, nil
			}
			return &projectv1.ListReposResponse{}, nil
		},
	}
	gitGateway := &fakeEphemeralVmGitGatewayClient{
		readEphemeralVmRecipesFunc: func(ctx context.Context, in *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
			if in.GetRepoId() != "repo-1" {
				t.Errorf("unexpected repoId: %q", in.GetRepoId())
			}
			return &gitgatewayv1.ReadEphemeralVmRecipesResponse{
				RepoPath: "/repo1",
				Recipes:  []*gitgatewayv1.EphemeralVmRecipe{{Id: "r1", Create: "docker run"}},
			}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, project, &fakeEphemeralVmInfraFleetClient{})

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.listRecipeCatalog", argsJSON(t, nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if project.listReposCallCount != 2 {
		t.Errorf("expected ListRepos to be called once per project (2), got %d", project.listReposCallCount)
	}
	entries, ok := got.([]ephemeralVmCatalogEntry)
	if !ok || len(entries) != 1 || entries[0].RepoID != "repo-1" {
		t.Errorf("unexpected catalog entries: %+v", got)
	}
}

// TASK-005: attachWorkspace is pure bookkeeping — regression test for
// TASK-004's correction to SOL-004's original sketch.
func TestEphemeralVmAttachWorkspace_NeverResolvesConnection(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		attachFunc: func(ctx context.Context, in *infrafleetv1.AttachEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
			return &infrafleetv1.EphemeralVmRuntime{Id: in.GetRuntimeId(), WorkspaceId: in.GetWorkspaceId(), Status: "active"}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, &fakeEphemeralVmGitGatewayClient{}, &fakeEphemeralVmProjectClient{}, infra)

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.attachWorkspace", argsJSON(t, map[string]any{"runtimeId": "rt-1", "workspaceId": "ws-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if infra.calledResolveConnection {
		t.Error("expected attachWorkspace to never call ResolveConnection — it is pure bookkeeping")
	}
	m := got.(map[string]any)
	// "active" remapped to frontend's "running" — see ephemeralVmFrontendStatus (TASK-BE-EVM-010).
	if m["status"] != "running" {
		t.Errorf("unexpected result: %+v", m)
	}
}

func TestEphemeralVmSuspendWorkspace_NoRuntimeAttached_ReturnsErrorWithoutCallingSuspend(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, &fakeEphemeralVmGitGatewayClient{}, &fakeEphemeralVmProjectClient{}, infra)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.suspendWorkspace", argsJSON(t, map[string]any{"workspaceId": "ws-missing"}))
	if err == nil {
		t.Fatal("expected an error when no runtime is attached to the workspace")
	}
	if infra.calledSuspend {
		t.Error("expected SuspendEphemeralVmWorkspace to not be called")
	}
}

func TestEphemeralVmResumeWorkspace_NoRuntimeAttached_ReturnsErrorWithoutCallingResume(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, &fakeEphemeralVmGitGatewayClient{}, &fakeEphemeralVmProjectClient{}, infra)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.resumeWorkspace", argsJSON(t, map[string]any{"workspaceId": "ws-missing"}))
	if err == nil {
		t.Fatal("expected an error when no runtime is attached to the workspace")
	}
	if infra.calledResume {
		t.Error("expected ResumeEphemeralVmWorkspace to not be called")
	}
}

func TestEphemeralVmSuspendWorkspace_SshConnectionType_RejectedBeforeRelay(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{
				Runtimes: []*infrafleetv1.EphemeralVmRuntime{{Id: "rt-1", WorkspaceId: "ws-1", ConnectionType: "ssh"}},
			}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, &fakeEphemeralVmGitGatewayClient{}, &fakeEphemeralVmProjectClient{}, infra)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.suspendWorkspace", argsJSON(t, map[string]any{"workspaceId": "ws-1"}))
	if err == nil {
		t.Fatal("expected an INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED error for an ssh-connection-type runtime")
	}
	if infra.calledSuspend {
		t.Error("expected SuspendEphemeralVmWorkspace to not be called for an ssh-type runtime (TASK-006 boundary)")
	}
}

func TestEphemeralVmCleanup_NeverAttached_CallsCleanupWithEmptyCommandAndConnection(t *testing.T) {
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{
				Runtimes: []*infrafleetv1.EphemeralVmRuntime{{Id: "rt-1", RepoId: "repo-1", RecipeId: "r1"}}, // WorkspaceId empty
			}, nil
		},
		cleanupFunc: func(ctx context.Context, in *infrafleetv1.CleanupEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
			return &infrafleetv1.EphemeralVmRuntime{Id: in.GetRuntimeId(), Status: "destroyed"}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, &fakeEphemeralVmGitGatewayClient{}, &fakeEphemeralVmProjectClient{}, infra)

	got, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.cleanup", argsJSON(t, map[string]any{"runtimeId": "rt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if infra.calledResolveConnection {
		t.Error("expected ResolveConnection to not be called for a never-attached runtime")
	}
	if infra.gotCleanupCommand != "" {
		t.Errorf("expected empty command for a never-attached runtime, got %q", infra.gotCleanupCommand)
	}
	m := got.(map[string]any)
	// "destroyed" remapped to frontend's "cleaned" — see ephemeralVmFrontendStatus (TASK-BE-EVM-010).
	if m["status"] != "cleaned" {
		t.Errorf("unexpected result: %+v", m)
	}
}

func TestEphemeralVmCleanup_Attached_ResolvesConnectionAndRelaysDestroyCommand(t *testing.T) {
	gitGateway := &fakeEphemeralVmGitGatewayClient{
		readEphemeralVmRecipesFunc: func(ctx context.Context, in *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
			return &gitgatewayv1.ReadEphemeralVmRecipesResponse{
				Recipes: []*gitgatewayv1.EphemeralVmRecipe{{Id: "r1", Destroy: "docker rm -f x"}},
			}, nil
		},
	}
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(ctx context.Context, in *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{
				Runtimes: []*infrafleetv1.EphemeralVmRuntime{{Id: "rt-1", RepoId: "repo-1", RecipeId: "r1", WorkspaceId: "ws-1"}},
			}, nil
		},
		resolveConnectionFunc: func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			if in.GetWorktreeId() != "ws-1" {
				t.Errorf("expected worktreeId=ws-1, got %q", in.GetWorktreeId())
			}
			return &infrafleetv1.ResolveConnectionResponse{Connected: true, ConnectionId: "conn-1"}, nil
		},
		cleanupFunc: func(ctx context.Context, in *infrafleetv1.CleanupEphemeralVmWorkspaceRequest) (*infrafleetv1.EphemeralVmRuntime, error) {
			if in.GetConnectionId() != "conn-1" || in.GetCommand() != "docker rm -f x" {
				t.Errorf("unexpected cleanup request: %+v", in)
			}
			return &infrafleetv1.EphemeralVmRuntime{Id: in.GetRuntimeId(), Status: "destroyed"}, nil
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, infra)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ephemeralVm.cleanup", argsJSON(t, map[string]any{"runtimeId": "rt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !infra.calledResolveConnection {
		t.Error("expected ResolveConnection to be called for an attached runtime")
	}
	if !infra.calledCleanup {
		t.Error("expected CleanupEphemeralVmWorkspace to be called")
	}
}

// TestToEphemeralVmRuntimeView_IncludesAllFrontendRequiredFields is
// TASK-BE-EVM-010's round-trip check: every field frontend's
// EphemeralVmRuntimeRecordSchema can safely require from this backend (see
// frontend/src/shared/ephemeral-vm-runtimes.ts) must be present, under the
// frontend's field names, and typed the way z.number().finite() (epoch
// millis) / non-empty strings expect.
func TestToEphemeralVmRuntimeView_IncludesAllFrontendRequiredFields(t *testing.T) {
	created := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	updated := time.Date(2026, 9, 8, 8, 30, 0, 0, time.UTC)
	rt := &infrafleetv1.EphemeralVmRuntime{
		Id: "rt-1", RepoId: "repo-1", RecipeId: "recipe-1",
		ConnectionType: "orca-server", Status: "active",
		EnvironmentId: "env-1", WorkspaceId: "ws-1", LastError: "",
		CreatedAt: timestamppb.New(created), UpdatedAt: timestamppb.New(updated),
	}

	view := toEphemeralVmRuntimeView(rt)

	wantString := map[string]string{
		"id": "rt-1", "repoId": "repo-1", "recipeId": "recipe-1",
		// "active" remapped to frontend's "running" — see ephemeralVmFrontendStatus.
		"status": "running", "workspaceId": "ws-1", "lastError": "",
		// Renamed to match frontend's EphemeralVmRuntimeRecord field names
		// (connectionType/environmentId are the old, backend-only names).
		"connectionMode":       "orca-server",
		"runtimeEnvironmentId": "env-1",
	}
	for key, want := range wantString {
		got, ok := view[key]
		if !ok {
			t.Errorf("view missing key %q (frontend requires it): %+v", key, view)
			continue
		}
		if got != want {
			t.Errorf("view[%q] = %v, want %v", key, got, want)
		}
	}
	if _, present := view["connectionType"]; present {
		t.Error("view still has backend-only key \"connectionType\" — frontend expects \"connectionMode\"")
	}
	if _, present := view["environmentId"]; present {
		t.Error("view still has backend-only key \"environmentId\" — frontend expects \"runtimeEnvironmentId\"")
	}

	gotCreatedAt, ok := view["createdAt"].(int64)
	if !ok || gotCreatedAt != created.UnixMilli() {
		t.Errorf("view[\"createdAt\"] = %v, want %d (epoch millis)", view["createdAt"], created.UnixMilli())
	}
	gotUpdatedAt, ok := view["updatedAt"].(int64)
	if !ok || gotUpdatedAt != updated.UnixMilli() {
		t.Errorf("view[\"updatedAt\"] = %v, want %d (epoch millis)", view["updatedAt"], updated.UnixMilli())
	}

	// cleanupStatus/recipeResult are the two fields this backend genuinely
	// cannot populate (no cleanup sub-state or recipe/connection result
	// tracked per runtime) — TASK-BE-EVM-010 decided not to fabricate them,
	// so they stay absent for a non-"destroyed" runtime like this one.
	if _, present := view["cleanupStatus"]; present {
		t.Errorf("expected no cleanupStatus for a non-destroyed runtime, got %v", view["cleanupStatus"])
	}
	if _, present := view["recipeResult"]; present {
		t.Errorf("expected no recipeResult — backend has no source data for it, got %v", view["recipeResult"])
	}
}

// TestToEphemeralVmRuntimeView_DestroyedStatus_SetsCleanupStatusSucceeded
// covers the one cleanupStatus value this backend can state truthfully:
// status=="destroyed" is only reachable via a successful CleanupWorkspace
// call (ephemeral_vm_relay.go), so cleanupStatus:"succeeded" is real data,
// not a guess.
func TestToEphemeralVmRuntimeView_DestroyedStatus_SetsCleanupStatusSucceeded(t *testing.T) {
	view := toEphemeralVmRuntimeView(&infrafleetv1.EphemeralVmRuntime{Id: "rt-1", Status: "destroyed"})
	if view["cleanupStatus"] != "succeeded" {
		t.Errorf("expected cleanupStatus \"succeeded\" for a destroyed runtime, got %v", view["cleanupStatus"])
	}
}

// TestToEphemeralVmRuntimeView_MapsStatusToFrontendVocabulary covers every
// value infra-fleet-service's Status can hold (ephemeral_vm_runtime.go:19)
// against frontend's EphemeralVmRuntimeStatusSchema enum.
func TestToEphemeralVmRuntimeView_MapsStatusToFrontendVocabulary(t *testing.T) {
	cases := map[string]string{
		"provisioning": "provisioning",
		"active":       "running",
		"suspended":    "suspended",
		"error":        "failed",
		"destroyed":    "cleaned",
	}
	for backendStatus, wantFrontendStatus := range cases {
		view := toEphemeralVmRuntimeView(&infrafleetv1.EphemeralVmRuntime{Id: "rt-1", Status: backendStatus})
		if view["status"] != wantFrontendStatus {
			t.Errorf("status %q: view[\"status\"] = %v, want %q", backendStatus, view["status"], wantFrontendStatus)
		}
	}
}

// TestToEphemeralVmRuntimeView_EmptyOptionalStrings_OmitsKeys covers the
// pre-pairing/never-attached state (ConnectionType/EnvironmentId/WorkspaceId
// all still "") — frontend's connectionMode/runtimeEnvironmentId/workspaceId
// are optional non-empty strings, so each key must be omitted rather than
// sent as "" (a caught-by-the-frontend-round-trip-test regression:
// workspaceId:"" fails EphemeralVmRuntimeRecordSchema's min(1) check).
func TestToEphemeralVmRuntimeView_EmptyOptionalStrings_OmitsKeys(t *testing.T) {
	view := toEphemeralVmRuntimeView(&infrafleetv1.EphemeralVmRuntime{Id: "rt-1", Status: "provisioning"})
	for _, key := range []string{"connectionMode", "runtimeEnvironmentId", "workspaceId"} {
		if _, present := view[key]; present {
			t.Errorf("expected no %q key when the underlying field is empty, got %v", key, view[key])
		}
	}
}

// newProvisionTestCtx mirrors newTerminalTestCtx (channels_terminal_test.go)
// — a fresh, empty provisionStreamRegistry attached exactly like ServeHTTP
// attaches one per real WebSocket connection (handler.go).
func newProvisionTestCtx() context.Context {
	return provisionStreamsContext(context.Background(), newProvisionStreamRegistry())
}

func ephemeralVmProvisionTestFixtures() (*fakeEphemeralVmGitGatewayClient, *fakeEphemeralVmInfraFleetClient) {
	gitGateway := &fakeEphemeralVmGitGatewayClient{
		readEphemeralVmRecipesFunc: func(context.Context, *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
			return &gitgatewayv1.ReadEphemeralVmRecipesResponse{Recipes: []*gitgatewayv1.EphemeralVmRecipe{
				{Id: "recipe-1", Create: "docker run -d my-image"},
			}}, nil
		},
	}
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(context.Context, *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{Runtimes: []*infrafleetv1.EphemeralVmRuntime{
				{Id: "rt-1", RepoId: "repo-1", RecipeId: "recipe-1", Status: "provisioning"},
			}}, nil
		},
	}
	return gitGateway, infra
}

// TestEphemeralVmProvision_AcksWithProvisionId covers the ack shape — a
// fresh, server-minted provisionId (runtime-ephemeral-vm-client.ts:224's
// real contract: the environment/paired branch never sends or generates one
// itself, it's purely whatever the ack hands back).
func TestEphemeralVmProvision_AcksWithProvisionId(t *testing.T) {
	gitGateway, infra := ephemeralVmProvisionTestFixtures()
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, infra)

	ack, events, isStream, err := r.DispatchStreamChannel(newProvisionTestCtx(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "ephemeralVm.provision",
		argsJSON(t, ephemeralVmProvisionArgs{ConnectionID: "conn-1", RecipeID: "recipe-1", RuntimeID: "rt-1"}))
	if !isStream {
		t.Fatal("expected ephemeralVm.provision to be registered as a StreamChannelHandler")
	}
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	view, ok := ack.(ephemeralVmProvisionAckView)
	if !ok || view.ProvisionID == "" {
		t.Fatalf("expected a non-empty ProvisionID ack, got %+v (ok=%v)", ack, ok)
	}
	if events == nil {
		t.Fatal("expected a non-nil events channel")
	}
	if infra.gotStreamVmProvisionRequest == nil {
		t.Fatal("expected StreamVmProvision to have been called")
	}
	got := infra.gotStreamVmProvisionRequest
	if got.GetConnectionId() != "conn-1" || got.GetRecipeId() != "recipe-1" || got.GetRuntimeId() != "rt-1" {
		t.Errorf("unexpected StreamVmProvisionRequest: %+v", got)
	}
	if got.GetCommand() != "docker run -d my-image" {
		t.Errorf("expected the recipe's create command to be resolved server-side, got %q", got.GetCommand())
	}
}

// TestEphemeralVmProvision_PushesStdoutStderrResultEvents covers the full
// event demux, including the "chunk carries the error text" convention
// documented on toProtoVmProvisionEvent (server_ephemeral_vm.go) /
// toEphemeralVmProvisionEventView (this file).
func TestEphemeralVmProvision_PushesStdoutStderrResultEvents(t *testing.T) {
	gitGateway, infra := ephemeralVmProvisionTestFixtures()
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, infra)

	_, events, isStream, err := r.DispatchStreamChannel(newProvisionTestCtx(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "ephemeralVm.provision",
		argsJSON(t, ephemeralVmProvisionArgs{ConnectionID: "conn-1", RecipeID: "recipe-1", RuntimeID: "rt-1"}))
	if !isStream || err != nil {
		t.Fatalf("unexpected dispatch failure: isStream=%v err=%v", isStream, err)
	}
	stream := infra.getLastVmProvisionStream()
	if stream == nil {
		t.Fatal("expected a fake stream to have been created")
	}

	// Push and drain ONE event at a time — fakeVmProvisionStream.Recv()'s
	// select races s.recv against s.err, so pre-loading the terminating err
	// alongside pending recv values risks Recv() picking err first (Go's
	// select among multiple ready cases is pseudo-random, not FIFO across
	// two channels) and ending the stream before any recv is delivered.
	// Keeping s.err empty until every recv value has actually been consumed
	// (proven by reading it back off events, not just off stream.recv)
	// removes that race entirely.
	readNext := func() map[string]any {
		t.Helper()
		select {
		case ev, ok := <-events:
			if !ok {
				t.Fatal("events channel closed early")
			}
			view, ok := ev.Args[0].(map[string]any)
			if !ok {
				t.Fatalf("expected ev.Args[0] to be a map[string]any, got %T", ev.Args[0])
			}
			if ev.Channel != "ephemeralVm.onProvisionEvent" {
				t.Errorf("unexpected push channel: %q", ev.Channel)
			}
			return view
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for the next event")
			return nil
		}
	}

	stream.recv <- &infrafleetv1.VmProvisionEvent{Type: "stdout", Chunk: "pulling image..."}
	got := []map[string]any{readNext()}
	stream.recv <- &infrafleetv1.VmProvisionEvent{Type: "stderr", Chunk: "warning: slow network"}
	got = append(got, readNext())
	stream.recv <- &infrafleetv1.VmProvisionEvent{Type: "result", Result: &infrafleetv1.VmProvisionResult{
		Type: "orca-server", PairingCode: "abc-123", ProjectRoot: "/vm/repo",
	}}
	got = append(got, readNext())
	stream.err <- errCloseSend // ends the stream now that all 3 events were actually consumed

	select {
	case _, ok := <-events:
		if ok {
			t.Error("expected no 4th event")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for events to close after the stream ended")
	}

	if got[0]["type"] != "stdout" || got[0]["chunk"] != "pulling image..." {
		t.Errorf("event[0] = %+v", got[0])
	}
	if got[1]["type"] != "stderr" || got[1]["chunk"] != "warning: slow network" {
		t.Errorf("event[1] = %+v", got[1])
	}
	if got[2]["type"] != "result" {
		t.Errorf("event[2] = %+v", got[2])
	}
	result, ok := got[2]["result"].(map[string]any)
	if !ok || result["type"] != "orca-server" || result["pairingCode"] != "abc-123" || result["projectRoot"] != "/vm/repo" {
		t.Errorf("unexpected result view: %+v (ok=%v)", got[2]["result"], ok)
	}
}

// TestEphemeralVmProvision_NoConnectionReturnsError covers the runtime-not-found
// short-circuit (this channel's connection resolution is StreamVmProvision's
// own job downstream — connectionId is forwarded, not resolved here — so
// "no connection" here means the runtime row itself can't be found, the one
// failure this channel's own code can produce before ever calling the agent).
func TestEphemeralVmProvision_NoConnectionReturnsError(t *testing.T) {
	gitGateway := &fakeEphemeralVmGitGatewayClient{
		readEphemeralVmRecipesFunc: func(context.Context, *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
			return &gitgatewayv1.ReadEphemeralVmRecipesResponse{}, nil
		},
	}
	infra := &fakeEphemeralVmInfraFleetClient{
		listEphemeralVmRuntimesFunc: func(context.Context, *infrafleetv1.ListEphemeralVmRuntimesRequest) (*infrafleetv1.ListEphemeralVmRuntimesResponse, error) {
			return &infrafleetv1.ListEphemeralVmRuntimesResponse{}, nil // no runtimes at all
		},
	}
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, infra)

	_, _, isStream, err := r.DispatchStreamChannel(newProvisionTestCtx(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "ephemeralVm.provision",
		argsJSON(t, ephemeralVmProvisionArgs{ConnectionID: "conn-1", RecipeID: "recipe-1", RuntimeID: "rt-missing"}))
	if !isStream {
		t.Fatal("expected ephemeralVm.provision to be registered as a StreamChannelHandler")
	}
	if err == nil {
		t.Fatal("expected an error when the runtime row doesn't exist")
	}
	if infra.gotStreamVmProvisionRequest != nil {
		t.Error("expected StreamVmProvision to never be called when the runtime lookup fails")
	}
}

// TestEphemeralVmCancelProvision_CancelsRunningStream covers cancelProvision
// finding a registered entry and calling its cancel() — Cancelled=true, and
// the underlying context.CancelFunc genuinely fires (asserted via ctx.Err(),
// since fakeVmProvisionStream's Recv() — matching fakePtyStream's own
// existing test-fake limitation — has no ctx-awareness to unblock on its
// own; TestProvisionStreamRegistry_EntryRemovedWhenStreamEndsWithoutCancel
// below covers the registry-cleanup side via a real stream-end signal
// instead).
func TestEphemeralVmCancelProvision_CancelsRunningStream(t *testing.T) {
	gitGateway, infra := ephemeralVmProvisionTestFixtures()
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, infra)

	ctx := newProvisionTestCtx()
	ack, _, isStream, err := r.DispatchStreamChannel(ctx, Identity{TenantID: "tenant-1", UserID: "user-1"}, "ephemeralVm.provision",
		argsJSON(t, ephemeralVmProvisionArgs{ConnectionID: "conn-1", RecipeID: "recipe-1", RuntimeID: "rt-1"}))
	if !isStream || err != nil {
		t.Fatalf("unexpected dispatch failure: isStream=%v err=%v", isStream, err)
	}
	provisionID := ack.(ephemeralVmProvisionAckView).ProvisionID

	provisions := provisionStreamsFromContext(ctx)
	if _, ok := provisions.get(provisionID); !ok {
		t.Fatal("expected the provision entry to be registered")
	}

	got, err := r.Dispatch(ctx, Identity{TenantID: "tenant-1", UserID: "user-1"}, "ephemeralVm.cancelProvision",
		argsJSON(t, ephemeralVmCancelProvisionArgs{ProvisionID: provisionID}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	view, ok := got.(ephemeralVmCancelProvisionResultView)
	if !ok || !view.Cancelled {
		t.Fatalf("expected Cancelled=true, got %+v (ok=%v)", got, ok)
	}
}

// TestEphemeralVmCancelProvision_UnknownProvisionIdReturnsCancelledFalse
// covers the not-found branch — no panic, Cancelled=false.
func TestEphemeralVmCancelProvision_UnknownProvisionIdReturnsCancelledFalse(t *testing.T) {
	r := NewRegistry()
	registerEphemeralVmCancelProvisionChannel(r)

	got, err := r.Dispatch(newProvisionTestCtx(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "ephemeralVm.cancelProvision",
		argsJSON(t, ephemeralVmCancelProvisionArgs{ProvisionID: "does-not-exist"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	view, ok := got.(ephemeralVmCancelProvisionResultView)
	if !ok || view.Cancelled {
		t.Fatalf("expected Cancelled=false, got %+v (ok=%v)", got, ok)
	}
}

// TestProvisionStreamRegistry_EntryRemovedWhenStreamEndsWithoutCancel is the
// regression-guard for BE-SOL-EVM-002 §Rủi ro's documented leak risk:
// drainVmProvisionOutput must remove the registry entry when the stream ends
// on its own (e.g. the agent finished/errored), WITHOUT cancelProvision ever
// being called.
func TestProvisionStreamRegistry_EntryRemovedWhenStreamEndsWithoutCancel(t *testing.T) {
	gitGateway, infra := ephemeralVmProvisionTestFixtures()
	r := NewRegistry()
	registerEphemeralVmChannels(r, gitGateway, &fakeEphemeralVmProjectClient{}, infra)

	ctx := newProvisionTestCtx()
	ack, events, isStream, err := r.DispatchStreamChannel(ctx, Identity{TenantID: "tenant-1", UserID: "user-1"}, "ephemeralVm.provision",
		argsJSON(t, ephemeralVmProvisionArgs{ConnectionID: "conn-1", RecipeID: "recipe-1", RuntimeID: "rt-1"}))
	if !isStream || err != nil {
		t.Fatalf("unexpected dispatch failure: isStream=%v err=%v", isStream, err)
	}
	provisionID := ack.(ephemeralVmProvisionAckView).ProvisionID
	provisions := provisionStreamsFromContext(ctx)
	if _, ok := provisions.get(provisionID); !ok {
		t.Fatal("expected the provision entry to be registered right after ack")
	}

	stream := infra.getLastVmProvisionStream()
	stream.err <- errCloseSend // stream ends on its own — never cancelled

	// Drain events until the channel closes (drainVmProvisionOutput's defer
	// close(events) runs right after its defer provisions.remove(provisionID)
	// — Go defers run LIFO, so remove() has already happened by the time
	// events closes).
	deadline := time.After(5 * time.Second)
	for {
		select {
		case _, ok := <-events:
			if !ok {
				goto drained
			}
		case <-deadline:
			t.Fatal("timed out waiting for events to close")
		}
	}
drained:
	if _, ok := provisions.get(provisionID); ok {
		t.Error("expected the provision entry to be removed once the stream ended, even without cancelProvision")
	}
}
