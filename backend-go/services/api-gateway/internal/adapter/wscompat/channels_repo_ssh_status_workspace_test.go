package wscompat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	infrafleetv1 "github.com/stablyai/orca-go/proto/gen/go/orca/infrafleet/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"
)

// fakeRepoProjectClient is a minimal test double for
// projectv1.ProjectServiceClient — embeds the (nil) interface so it
// satisfies every method, overriding only what registerRepoChannels' tests
// exercise. Kept local to this file (not channels_test.go's fakes) to avoid
// merge conflicts with the parallel git.*/files.* pass — see this file's
// sibling channels_repo_ssh_status_workspace.go's top doc comment.
type fakeRepoProjectClient struct {
	projectv1.ProjectServiceClient

	addRepoFunc             func(ctx context.Context, in *projectv1.AddRepoRequest) (*projectv1.AddRepoResponse, error)
	listReposFunc           func(ctx context.Context, in *projectv1.ListReposRequest) (*projectv1.ListReposResponse, error)
	reorderReposFunc        func(ctx context.Context, in *projectv1.ReorderReposRequest) (*projectv1.ReorderReposResponse, error)
	removeRepoFunc          func(ctx context.Context, in *projectv1.RemoveRepoRequest) (*projectv1.RemoveRepoResponse, error)
	updateRepoFunc          func(ctx context.Context, in *projectv1.UpdateRepoRequest) (*projectv1.UpdateRepoResponse, error)
	assignRepoToProjectFunc func(ctx context.Context, in *projectv1.AssignRepoToProjectRequest) (*projectv1.AssignRepoToProjectResponse, error)
	rebindRepoDevServerFunc func(ctx context.Context, in *projectv1.RebindRepoDevServerRequest) (*projectv1.RebindRepoDevServerResponse, error)

	listRepoMembersFunc      func(ctx context.Context, in *projectv1.ListRepoMembersRequest) (*projectv1.ListRepoMembersResponse, error)
	addRepoMemberFunc        func(ctx context.Context, in *projectv1.AddRepoMemberRequest) (*projectv1.AddRepoMemberResponse, error)
	removeRepoMemberFunc     func(ctx context.Context, in *projectv1.RemoveRepoMemberRequest) (*projectv1.RemoveRepoMemberResponse, error)
	updateRepoMemberRoleFunc func(ctx context.Context, in *projectv1.UpdateRepoMemberRoleRequest) (*projectv1.UpdateRepoMemberRoleResponse, error)

	listSparsePresetsFunc  func(ctx context.Context, in *projectv1.ListSparsePresetsRequest) (*projectv1.ListSparsePresetsResponse, error)
	saveSparsePresetFunc   func(ctx context.Context, in *projectv1.SaveSparsePresetRequest) (*projectv1.SaveSparsePresetResponse, error)
	removeSparsePresetFunc func(ctx context.Context, in *projectv1.RemoveSparsePresetRequest) (*projectv1.RemoveSparsePresetResponse, error)

	// getRepoFunc/listWorktreesFunc: BUG-016's repoId -> worktreeId
	// resolution (resolveWorktreeIDForRepo) in registerWorkspacePortsChannels.
	getRepoFunc       func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error)
	listWorktreesFunc func(ctx context.Context, in *projectv1.ListWorktreesRequest) (*projectv1.ListWorktreesResponse, error)
}

func (f *fakeRepoProjectClient) AddRepo(ctx context.Context, in *projectv1.AddRepoRequest, _ ...grpc.CallOption) (*projectv1.AddRepoResponse, error) {
	return f.addRepoFunc(ctx, in)
}
func (f *fakeRepoProjectClient) ListRepos(ctx context.Context, in *projectv1.ListReposRequest, _ ...grpc.CallOption) (*projectv1.ListReposResponse, error) {
	return f.listReposFunc(ctx, in)
}
func (f *fakeRepoProjectClient) ReorderRepos(ctx context.Context, in *projectv1.ReorderReposRequest, _ ...grpc.CallOption) (*projectv1.ReorderReposResponse, error) {
	return f.reorderReposFunc(ctx, in)
}
func (f *fakeRepoProjectClient) RemoveRepo(ctx context.Context, in *projectv1.RemoveRepoRequest, _ ...grpc.CallOption) (*projectv1.RemoveRepoResponse, error) {
	return f.removeRepoFunc(ctx, in)
}
func (f *fakeRepoProjectClient) UpdateRepo(ctx context.Context, in *projectv1.UpdateRepoRequest, _ ...grpc.CallOption) (*projectv1.UpdateRepoResponse, error) {
	return f.updateRepoFunc(ctx, in)
}
func (f *fakeRepoProjectClient) AssignRepoToProject(ctx context.Context, in *projectv1.AssignRepoToProjectRequest, _ ...grpc.CallOption) (*projectv1.AssignRepoToProjectResponse, error) {
	return f.assignRepoToProjectFunc(ctx, in)
}
func (f *fakeRepoProjectClient) RebindRepoDevServer(ctx context.Context, in *projectv1.RebindRepoDevServerRequest, _ ...grpc.CallOption) (*projectv1.RebindRepoDevServerResponse, error) {
	return f.rebindRepoDevServerFunc(ctx, in)
}
func (f *fakeRepoProjectClient) ListRepoMembers(ctx context.Context, in *projectv1.ListRepoMembersRequest, _ ...grpc.CallOption) (*projectv1.ListRepoMembersResponse, error) {
	return f.listRepoMembersFunc(ctx, in)
}
func (f *fakeRepoProjectClient) AddRepoMember(ctx context.Context, in *projectv1.AddRepoMemberRequest, _ ...grpc.CallOption) (*projectv1.AddRepoMemberResponse, error) {
	return f.addRepoMemberFunc(ctx, in)
}
func (f *fakeRepoProjectClient) RemoveRepoMember(ctx context.Context, in *projectv1.RemoveRepoMemberRequest, _ ...grpc.CallOption) (*projectv1.RemoveRepoMemberResponse, error) {
	return f.removeRepoMemberFunc(ctx, in)
}
func (f *fakeRepoProjectClient) UpdateRepoMemberRole(ctx context.Context, in *projectv1.UpdateRepoMemberRoleRequest, _ ...grpc.CallOption) (*projectv1.UpdateRepoMemberRoleResponse, error) {
	return f.updateRepoMemberRoleFunc(ctx, in)
}
func (f *fakeRepoProjectClient) ListSparsePresets(ctx context.Context, in *projectv1.ListSparsePresetsRequest, _ ...grpc.CallOption) (*projectv1.ListSparsePresetsResponse, error) {
	return f.listSparsePresetsFunc(ctx, in)
}
func (f *fakeRepoProjectClient) SaveSparsePreset(ctx context.Context, in *projectv1.SaveSparsePresetRequest, _ ...grpc.CallOption) (*projectv1.SaveSparsePresetResponse, error) {
	return f.saveSparsePresetFunc(ctx, in)
}
func (f *fakeRepoProjectClient) RemoveSparsePreset(ctx context.Context, in *projectv1.RemoveSparsePresetRequest, _ ...grpc.CallOption) (*projectv1.RemoveSparsePresetResponse, error) {
	return f.removeSparsePresetFunc(ctx, in)
}
func (f *fakeRepoProjectClient) GetRepo(ctx context.Context, in *projectv1.GetRepoRequest, _ ...grpc.CallOption) (*projectv1.GetRepoResponse, error) {
	return f.getRepoFunc(ctx, in)
}
func (f *fakeRepoProjectClient) ListWorktrees(ctx context.Context, in *projectv1.ListWorktreesRequest, _ ...grpc.CallOption) (*projectv1.ListWorktreesResponse, error) {
	return f.listWorktreesFunc(ctx, in)
}

// fakeRepoGitGatewayClient is a minimal test double for
// gitgatewayv1.GitGatewayServiceClient covering only the 8 repo.*-owned
// RPCs this file's channels call.
type fakeRepoGitGatewayClient struct {
	gitgatewayv1.GitGatewayServiceClient

	cloneFunc                  func(ctx context.Context, in *gitgatewayv1.CloneRequest) (*gitgatewayv1.CloneResponse, error)
	baseRefDefaultFunc         func(ctx context.Context, in *gitgatewayv1.BaseRefDefaultRequest) (*gitgatewayv1.BaseRefDefaultResponse, error)
	searchRefsFunc             func(ctx context.Context, in *gitgatewayv1.SearchRefsRequest) (*gitgatewayv1.SearchRefsResponse, error)
	initRepoFunc               func(ctx context.Context, in *gitgatewayv1.InitRepoRequest) (*gitgatewayv1.InitRepoResponse, error)
	checkHooksFunc             func(ctx context.Context, in *gitgatewayv1.CheckHooksRequest) (*gitgatewayv1.CheckHooksResponse, error)
	readIssueCommandFunc       func(ctx context.Context, in *gitgatewayv1.ReadIssueCommandRequest) (*gitgatewayv1.ReadIssueCommandResponse, error)
	writeIssueCommandFunc      func(ctx context.Context, in *gitgatewayv1.WriteIssueCommandRequest) (*emptypb.Empty, error)
	scanSetupScriptImportsFunc func(ctx context.Context, in *gitgatewayv1.ScanSetupScriptImportsRequest) (*gitgatewayv1.ScanSetupScriptImportsResponse, error)
}

func (f *fakeRepoGitGatewayClient) Clone(ctx context.Context, in *gitgatewayv1.CloneRequest, _ ...grpc.CallOption) (*gitgatewayv1.CloneResponse, error) {
	return f.cloneFunc(ctx, in)
}
func (f *fakeRepoGitGatewayClient) BaseRefDefault(ctx context.Context, in *gitgatewayv1.BaseRefDefaultRequest, _ ...grpc.CallOption) (*gitgatewayv1.BaseRefDefaultResponse, error) {
	return f.baseRefDefaultFunc(ctx, in)
}
func (f *fakeRepoGitGatewayClient) SearchRefs(ctx context.Context, in *gitgatewayv1.SearchRefsRequest, _ ...grpc.CallOption) (*gitgatewayv1.SearchRefsResponse, error) {
	return f.searchRefsFunc(ctx, in)
}
func (f *fakeRepoGitGatewayClient) InitRepo(ctx context.Context, in *gitgatewayv1.InitRepoRequest, _ ...grpc.CallOption) (*gitgatewayv1.InitRepoResponse, error) {
	return f.initRepoFunc(ctx, in)
}
func (f *fakeRepoGitGatewayClient) CheckHooks(ctx context.Context, in *gitgatewayv1.CheckHooksRequest, _ ...grpc.CallOption) (*gitgatewayv1.CheckHooksResponse, error) {
	return f.checkHooksFunc(ctx, in)
}
func (f *fakeRepoGitGatewayClient) ReadIssueCommand(ctx context.Context, in *gitgatewayv1.ReadIssueCommandRequest, _ ...grpc.CallOption) (*gitgatewayv1.ReadIssueCommandResponse, error) {
	return f.readIssueCommandFunc(ctx, in)
}

// WriteIssueCommand returns google.protobuf.Empty on the wire; this fake
// ignores that and reports via error only, since none of this file's tests
// need to inspect a successful Empty response's fields.
func (f *fakeRepoGitGatewayClient) WriteIssueCommand(ctx context.Context, in *gitgatewayv1.WriteIssueCommandRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.writeIssueCommandFunc(ctx, in)
}
func (f *fakeRepoGitGatewayClient) ScanSetupScriptImports(ctx context.Context, in *gitgatewayv1.ScanSetupScriptImportsRequest, _ ...grpc.CallOption) (*gitgatewayv1.ScanSetupScriptImportsResponse, error) {
	return f.scanSetupScriptImportsFunc(ctx, in)
}

// fakeRepoSshStatusWorkspaceInfraFleetClient is a minimal test double for
// infrafleetv1.InfraFleetServiceClient covering ssh.*/workspacePorts.*'s
// backing RPCs — kept separate from channels_test.go's fakeInfraFleetClient
// per this file's merge-conflict-avoidance rationale.
type fakeRepoSshStatusWorkspaceInfraFleetClient struct {
	infrafleetv1.InfraFleetServiceClient

	listSshTargetsFunc      func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error)
	getSshStateFunc         func(ctx context.Context, in *infrafleetv1.GetSshStateRequest) (*infrafleetv1.GetSshStateResponse, error)
	establishConnectionFunc func(ctx context.Context, in *infrafleetv1.EstablishConnectionRequest) (*infrafleetv1.Connection, error)
	scanWorkspacePortsFunc  func(ctx context.Context, in *infrafleetv1.ScanWorkspacePortsRequest) (*infrafleetv1.ScanWorkspacePortsResponse, error)
	killWorkspacePortFunc   func(ctx context.Context, in *infrafleetv1.KillWorkspacePortRequest) (*infrafleetv1.KillWorkspacePortResponse, error)
	// resolveConnectionFunc: BUG-016's worktreeId -> connectionId resolution
	// (resolveConnectionIDForWorktree), reused by registerWorkspacePortsChannels.
	resolveConnectionFunc func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error)
}

func (f *fakeRepoSshStatusWorkspaceInfraFleetClient) ListSshTargets(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest, _ ...grpc.CallOption) (*infrafleetv1.ListSshTargetsResponse, error) {
	return f.listSshTargetsFunc(ctx, in)
}
func (f *fakeRepoSshStatusWorkspaceInfraFleetClient) GetSshState(ctx context.Context, in *infrafleetv1.GetSshStateRequest, _ ...grpc.CallOption) (*infrafleetv1.GetSshStateResponse, error) {
	return f.getSshStateFunc(ctx, in)
}
func (f *fakeRepoSshStatusWorkspaceInfraFleetClient) EstablishConnection(ctx context.Context, in *infrafleetv1.EstablishConnectionRequest, _ ...grpc.CallOption) (*infrafleetv1.Connection, error) {
	return f.establishConnectionFunc(ctx, in)
}
func (f *fakeRepoSshStatusWorkspaceInfraFleetClient) ScanWorkspacePorts(ctx context.Context, in *infrafleetv1.ScanWorkspacePortsRequest, _ ...grpc.CallOption) (*infrafleetv1.ScanWorkspacePortsResponse, error) {
	return f.scanWorkspacePortsFunc(ctx, in)
}
func (f *fakeRepoSshStatusWorkspaceInfraFleetClient) KillWorkspacePort(ctx context.Context, in *infrafleetv1.KillWorkspacePortRequest, _ ...grpc.CallOption) (*infrafleetv1.KillWorkspacePortResponse, error) {
	return f.killWorkspacePortFunc(ctx, in)
}
func (f *fakeRepoSshStatusWorkspaceInfraFleetClient) ResolveConnection(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest, _ ...grpc.CallOption) (*infrafleetv1.ResolveConnectionResponse, error) {
	return f.resolveConnectionFunc(ctx, in)
}

// ── repo.* ───────────────────────────────────────────────────────────────

func TestRegisterRepoChannels_AddListReorderRmUpdate(t *testing.T) {
	fake := &fakeRepoProjectClient{}
	r := NewRegistry()
	registerRepoChannels(r, fake, &fakeRepoGitGatewayClient{})

	t.Run("repo.add", func(t *testing.T) {
		var gotReq *projectv1.AddRepoRequest
		fake.addRepoFunc = func(ctx context.Context, in *projectv1.AddRepoRequest) (*projectv1.AddRepoResponse, error) {
			gotReq = in
			return &projectv1.AddRepoResponse{Repo: &projectv1.Repo{Id: "r1"}}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.add",
			argsJSON(t, map[string]any{"projectId": "p1", "url": "https://x", "displayName": "X", "devServerId": "ds1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetProjectId() != "p1" || gotReq.GetUrl() != "https://x" || gotReq.GetDisplayName() != "X" || gotReq.GetDevServerId() != "ds1" {
			t.Errorf("unexpected AddRepoRequest: %+v", gotReq)
		}
	})

	t.Run("repo.rebindDevServer", func(t *testing.T) {
		var gotReq *projectv1.RebindRepoDevServerRequest
		fake.rebindRepoDevServerFunc = func(ctx context.Context, in *projectv1.RebindRepoDevServerRequest) (*projectv1.RebindRepoDevServerResponse, error) {
			gotReq = in
			return &projectv1.RebindRepoDevServerResponse{Repo: &projectv1.Repo{Id: "r1", DevServerId: "ds2"}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.rebindDevServer",
			argsJSON(t, map[string]any{"repoId": "r1", "newDevServerId": "ds2"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetNewDevServerId() != "ds2" {
			t.Errorf("unexpected RebindRepoDevServerRequest: %+v", gotReq)
		}
		view, ok := result.(repoView)
		if !ok || view.DevServerID != "ds2" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("repo.list", func(t *testing.T) {
		var gotReq *projectv1.ListReposRequest
		fake.listReposFunc = func(ctx context.Context, in *projectv1.ListReposRequest) (*projectv1.ListReposResponse, error) {
			gotReq = in
			return &projectv1.ListReposResponse{Repos: []*projectv1.Repo{{Id: "r1"}}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.list",
			argsJSON(t, map[string]any{"projectId": "p1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetProjectId() != "p1" {
			t.Errorf("unexpected ListReposRequest: %+v", gotReq)
		}
		// Wrapped in {repos: [...]}, not a bare array — see the handler's
		// doc comment. Both frontend call sites do `(await
		// callRuntimeResult<{ repos: Repo[] }>('repo.list')).repos`.
		wrapped, ok := result.(map[string]any)
		if !ok {
			t.Fatalf("unexpected result type %T, want map[string]any{\"repos\": ...}", result)
		}
		repos, ok := wrapped["repos"].([]repoView)
		if !ok || len(repos) != 1 || repos[0].ID != "r1" {
			t.Errorf("unexpected repos: %+v", wrapped["repos"])
		}
	})

	t.Run("repo.list returns an empty array, not null, when there are no repos", func(t *testing.T) {
		fake.listReposFunc = func(ctx context.Context, in *projectv1.ListReposRequest) (*projectv1.ListReposResponse, error) {
			return &projectv1.ListReposResponse{}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.list", argsJSON(t, map[string]any{}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		raw, err := json.Marshal(result)
		if err != nil {
			t.Fatalf("marshal result: %v", err)
		}
		if string(raw) != `{"repos":[]}` {
			t.Errorf("want {\"repos\":[]}, got %s", raw)
		}
	})

	t.Run("repo.reorder", func(t *testing.T) {
		var gotReq *projectv1.ReorderReposRequest
		fake.reorderReposFunc = func(ctx context.Context, in *projectv1.ReorderReposRequest) (*projectv1.ReorderReposResponse, error) {
			gotReq = in
			return &projectv1.ReorderReposResponse{}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.reorder",
			argsJSON(t, map[string]any{"projectId": "p1", "repoIdsInOrder": []string{"r2", "r1"}}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetProjectId() != "p1" || len(gotReq.GetRepoIdsInOrder()) != 2 {
			t.Errorf("unexpected ReorderReposRequest: %+v", gotReq)
		}
	})

	t.Run("repo.rm", func(t *testing.T) {
		var gotReq *projectv1.RemoveRepoRequest
		fake.removeRepoFunc = func(ctx context.Context, in *projectv1.RemoveRepoRequest) (*projectv1.RemoveRepoResponse, error) {
			gotReq = in
			return &projectv1.RemoveRepoResponse{}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.rm",
			argsJSON(t, map[string]any{"repoId": "r1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" {
			t.Errorf("unexpected RemoveRepoRequest: %+v", gotReq)
		}
	})

	t.Run("repo.update", func(t *testing.T) {
		var gotReq *projectv1.UpdateRepoRequest
		fake.updateRepoFunc = func(ctx context.Context, in *projectv1.UpdateRepoRequest) (*projectv1.UpdateRepoResponse, error) {
			gotReq = in
			return &projectv1.UpdateRepoResponse{Repo: &projectv1.Repo{Id: "r1", Url: "https://new"}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.update",
			argsJSON(t, map[string]any{"repoId": "r1", "url": "https://new"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetUrl() != "https://new" {
			t.Errorf("unexpected UpdateRepoRequest: %+v", gotReq)
		}
		repo, ok := result.(repoView)
		if !ok || repo.URL != "https://new" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("repo.assignToProject", func(t *testing.T) {
		var gotReq *projectv1.AssignRepoToProjectRequest
		fake.assignRepoToProjectFunc = func(ctx context.Context, in *projectv1.AssignRepoToProjectRequest) (*projectv1.AssignRepoToProjectResponse, error) {
			gotReq = in
			return &projectv1.AssignRepoToProjectResponse{Repo: &projectv1.Repo{Id: "r1", ProjectId: "target"}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.assignToProject",
			argsJSON(t, map[string]any{"repoId": "r1", "targetProjectId": "target"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetTargetProjectId() != "target" {
			t.Errorf("unexpected AssignRepoToProjectRequest: %+v", gotReq)
		}
		repo, ok := result.(repoView)
		if !ok || repo.ProjectID != "target" {
			t.Errorf("unexpected result: %+v", result)
		}
	})
}

func TestRegisterRepoChannels_GitGatewayOwnedMethods(t *testing.T) {
	git := &fakeRepoGitGatewayClient{}
	r := NewRegistry()
	registerRepoChannels(r, &fakeRepoProjectClient{}, git)

	t.Run("repo.clone", func(t *testing.T) {
		var gotReq *gitgatewayv1.CloneRequest
		git.cloneFunc = func(ctx context.Context, in *gitgatewayv1.CloneRequest) (*gitgatewayv1.CloneResponse, error) {
			gotReq = in
			return &gitgatewayv1.CloneResponse{WorktreePath: "/repo", DefaultBranch: "main"}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.clone",
			argsJSON(t, map[string]any{"devServerId": "ds1", "url": "https://x", "destPath": "/repo"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetDevServerId() != "ds1" || gotReq.GetUrl() != "https://x" || gotReq.GetDestPath() != "/repo" {
			t.Errorf("unexpected CloneRequest: %+v", gotReq)
		}
	})

	t.Run("repo.baseRefDefault", func(t *testing.T) {
		var gotReq *gitgatewayv1.BaseRefDefaultRequest
		git.baseRefDefaultFunc = func(ctx context.Context, in *gitgatewayv1.BaseRefDefaultRequest) (*gitgatewayv1.BaseRefDefaultResponse, error) {
			gotReq = in
			return &gitgatewayv1.BaseRefDefaultResponse{Ref: "main"}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.baseRefDefault",
			argsJSON(t, map[string]any{"repoId": "r1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" {
			t.Errorf("unexpected BaseRefDefaultRequest: %+v", gotReq)
		}
	})

	t.Run("repo.searchRefs", func(t *testing.T) {
		var gotReq *gitgatewayv1.SearchRefsRequest
		git.searchRefsFunc = func(ctx context.Context, in *gitgatewayv1.SearchRefsRequest) (*gitgatewayv1.SearchRefsResponse, error) {
			gotReq = in
			return &gitgatewayv1.SearchRefsResponse{Refs: []string{"main"}}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.searchRefs",
			argsJSON(t, map[string]any{"repoId": "r1", "query": "mai"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetQuery() != "mai" {
			t.Errorf("unexpected SearchRefsRequest: %+v", gotReq)
		}
	})

	t.Run("repo.create", func(t *testing.T) {
		var gotReq *gitgatewayv1.InitRepoRequest
		git.initRepoFunc = func(ctx context.Context, in *gitgatewayv1.InitRepoRequest) (*gitgatewayv1.InitRepoResponse, error) {
			gotReq = in
			return &gitgatewayv1.InitRepoResponse{Path: "/repo", DefaultBranch: "main"}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.create",
			argsJSON(t, map[string]any{"devServerId": "ds1", "destPath": "/repo", "defaultBranch": "main"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetDevServerId() != "ds1" || gotReq.GetDestPath() != "/repo" || gotReq.GetDefaultBranch() != "main" {
			t.Errorf("unexpected InitRepoRequest: %+v", gotReq)
		}
	})

	t.Run("repo.create with a remote URL", func(t *testing.T) {
		var gotReq *gitgatewayv1.InitRepoRequest
		git.initRepoFunc = func(ctx context.Context, in *gitgatewayv1.InitRepoRequest) (*gitgatewayv1.InitRepoResponse, error) {
			gotReq = in
			return &gitgatewayv1.InitRepoResponse{Path: "/repo", DefaultBranch: "main", RemoteAdded: true}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.create",
			argsJSON(t, map[string]any{
				"devServerId": "ds1", "destPath": "/repo",
				"remoteUrl": "https://example.com/org/repo.git", "remoteName": "upstream",
			}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRemoteUrl() != "https://example.com/org/repo.git" || gotReq.GetRemoteName() != "upstream" {
			t.Errorf("unexpected InitRepoRequest: %+v", gotReq)
		}
		view, ok := result.(initRepoResultView)
		if !ok || !view.RemoteAdded {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("repo.hooksCheck", func(t *testing.T) {
		var gotReq *gitgatewayv1.CheckHooksRequest
		git.checkHooksFunc = func(ctx context.Context, in *gitgatewayv1.CheckHooksRequest) (*gitgatewayv1.CheckHooksResponse, error) {
			gotReq = in
			return &gitgatewayv1.CheckHooksResponse{OrcaHooksCurrent: true}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.hooksCheck",
			argsJSON(t, map[string]any{"repo": "r1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" {
			t.Errorf("unexpected CheckHooksRequest: %+v", gotReq)
		}
	})

	t.Run("repo.issueCommandRead", func(t *testing.T) {
		var gotReq *gitgatewayv1.ReadIssueCommandRequest
		git.readIssueCommandFunc = func(ctx context.Context, in *gitgatewayv1.ReadIssueCommandRequest) (*gitgatewayv1.ReadIssueCommandResponse, error) {
			gotReq = in
			return &gitgatewayv1.ReadIssueCommandResponse{Content: "x", Exists: true}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.issueCommandRead",
			argsJSON(t, map[string]any{"repo": "r1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" {
			t.Errorf("unexpected ReadIssueCommandRequest: %+v", gotReq)
		}
	})

	t.Run("repo.issueCommandWrite", func(t *testing.T) {
		var gotReq *gitgatewayv1.WriteIssueCommandRequest
		git.writeIssueCommandFunc = func(ctx context.Context, in *gitgatewayv1.WriteIssueCommandRequest) (*emptypb.Empty, error) {
			gotReq = in
			return &emptypb.Empty{}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.issueCommandWrite",
			argsJSON(t, map[string]any{"repo": "r1", "content": "x"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetContent() != "x" {
			t.Errorf("unexpected WriteIssueCommandRequest: %+v", gotReq)
		}
	})

	t.Run("repo.setupScriptImports", func(t *testing.T) {
		var gotReq *gitgatewayv1.ScanSetupScriptImportsRequest
		git.scanSetupScriptImportsFunc = func(ctx context.Context, in *gitgatewayv1.ScanSetupScriptImportsRequest) (*gitgatewayv1.ScanSetupScriptImportsResponse, error) {
			gotReq = in
			return &gitgatewayv1.ScanSetupScriptImportsResponse{ImportedPaths: []string{"a"}}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.setupScriptImports",
			argsJSON(t, map[string]any{"repo": "r1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" {
			t.Errorf("unexpected ScanSetupScriptImportsRequest: %+v", gotReq)
		}
	})
}

func TestRegisterRepoChannels_RegistrationCoverage(t *testing.T) {
	r := NewRegistry()
	registerRepoChannels(r, &fakeRepoProjectClient{}, &fakeRepoGitGatewayClient{})

	want := []string{
		"repo.add", "repo.list", "repo.reorder", "repo.rm", "repo.update", "repo.assignToProject", "repo.rebindDevServer",
		"repo.getMembers", "repo.addMember", "repo.removeMember", "repo.updateMemberRole",
		"repo.clone", "repo.baseRefDefault", "repo.searchRefs", "repo.create",
		"repo.hooksCheck", "repo.issueCommandRead", "repo.issueCommandWrite",
		"repo.setupScriptImports",
		"sparsePresets.list", "sparsePresets.save", "sparsePresets.remove",
	}
	for _, channel := range want {
		if _, ok := r.handlers[channel]; !ok {
			t.Errorf("expected channel %q to be registered", channel)
		}
	}
}

// TestRegisterRepoChannels_MemberChannels covers the repo-scoped
// functional-role tier (developer/lead/admin), layered on top of
// project.getMembers/addMember/removeMember/updateMemberRole's project-level
// owner/member tier (channels_tenant_project_test.go).
func TestRegisterRepoChannels_MemberChannels(t *testing.T) {
	fake := &fakeRepoProjectClient{}
	r := NewRegistry()
	registerRepoChannels(r, fake, &fakeRepoGitGatewayClient{})

	t.Run("repo.getMembers", func(t *testing.T) {
		var gotReq *projectv1.ListRepoMembersRequest
		fake.listRepoMembersFunc = func(ctx context.Context, in *projectv1.ListRepoMembersRequest) (*projectv1.ListRepoMembersResponse, error) {
			gotReq = in
			return &projectv1.ListRepoMembersResponse{Members: []*projectv1.RepoMember{{UserId: "u1", Role: projectv1.RepoRole_REPO_ROLE_DEVELOPER}}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.getMembers",
			argsJSON(t, map[string]any{"repoId": "r1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" {
			t.Errorf("unexpected ListRepoMembersRequest: %+v", gotReq)
		}
		// Wire shape must be {userId, role: "developer"} — repoMemberView, not
		// the raw *projectv1.RepoMember proto struct: that Role field is a
		// protobuf enum with no custom MarshalJSON, so plain encoding/json
		// would serialize it as a bare number instead of a role string,
		// leaving RepoMemberManager.tsx's <Select> permanently unable to
		// match any option (confirmed live on b15.openledger.vn).
		members, ok := result.([]repoMemberView)
		if !ok || len(members) != 1 || members[0] != (repoMemberView{UserID: "u1", Role: "developer"}) {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("repo.addMember", func(t *testing.T) {
		var gotReq *projectv1.AddRepoMemberRequest
		fake.addRepoMemberFunc = func(ctx context.Context, in *projectv1.AddRepoMemberRequest) (*projectv1.AddRepoMemberResponse, error) {
			gotReq = in
			return &projectv1.AddRepoMemberResponse{Member: &projectv1.RepoMember{UserId: in.GetUserId(), Role: in.GetRole()}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.addMember",
			argsJSON(t, map[string]any{"repoId": "r1", "userId": "u2", "role": "developer"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetUserId() != "u2" || gotReq.GetRole() != projectv1.RepoRole_REPO_ROLE_DEVELOPER {
			t.Errorf("unexpected AddRepoMemberRequest: %+v", gotReq)
		}
		member, ok := result.(repoMemberView)
		if !ok || member.Role != "developer" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("repo.removeMember", func(t *testing.T) {
		var gotReq *projectv1.RemoveRepoMemberRequest
		fake.removeRepoMemberFunc = func(ctx context.Context, in *projectv1.RemoveRepoMemberRequest) (*projectv1.RemoveRepoMemberResponse, error) {
			gotReq = in
			return &projectv1.RemoveRepoMemberResponse{}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.removeMember",
			argsJSON(t, map[string]any{"repoId": "r1", "userId": "u2"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetUserId() != "u2" {
			t.Errorf("unexpected RemoveRepoMemberRequest: %+v", gotReq)
		}
	})

	t.Run("repo.updateMemberRole", func(t *testing.T) {
		var gotReq *projectv1.UpdateRepoMemberRoleRequest
		fake.updateRepoMemberRoleFunc = func(ctx context.Context, in *projectv1.UpdateRepoMemberRoleRequest) (*projectv1.UpdateRepoMemberRoleResponse, error) {
			gotReq = in
			return &projectv1.UpdateRepoMemberRoleResponse{Member: &projectv1.RepoMember{UserId: in.GetUserId(), Role: in.GetRole()}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "repo.updateMemberRole",
			argsJSON(t, map[string]any{"repoId": "r1", "userId": "u2", "role": "admin"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRole() != projectv1.RepoRole_REPO_ROLE_ADMIN {
			t.Errorf("want role mapped to REPO_ROLE_ADMIN, got %v", gotReq.GetRole())
		}
		member, ok := result.(repoMemberView)
		if !ok || member.Role != "admin" {
			t.Errorf("unexpected result: %+v", result)
		}
	})
}

// TestRegisterRepoChannels_SparsePresetChannels covers sparsePresets.*
// (saved sparse-checkout directory sets, scoped to one repo) — a genuine
// new feature this pass, not a wiring fix; confirmed live on
// b15.openledger.vn as "channel \"sparsePresets.list\" is not yet
// implemented in backend-go" before this.
func TestRegisterRepoChannels_SparsePresetChannels(t *testing.T) {
	fake := &fakeRepoProjectClient{}
	r := NewRegistry()
	registerRepoChannels(r, fake, &fakeRepoGitGatewayClient{})

	t.Run("sparsePresets.list", func(t *testing.T) {
		var gotReq *projectv1.ListSparsePresetsRequest
		fake.listSparsePresetsFunc = func(ctx context.Context, in *projectv1.ListSparsePresetsRequest) (*projectv1.ListSparsePresetsResponse, error) {
			gotReq = in
			return &projectv1.ListSparsePresetsResponse{Presets: []*projectv1.SparsePreset{
				{Id: "preset-1", RepoId: "r1", Name: "Backend", Directories: []string{"src", "test"}},
			}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "sparsePresets.list",
			argsJSON(t, map[string]any{"repoId": "r1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" {
			t.Errorf("unexpected ListSparsePresetsRequest: %+v", gotReq)
		}
		// Wire shape must be {id, repoId, name, directories, createdAt,
		// updatedAt} — matches shared/types.ts's SparsePreset exactly.
		presets, ok := result.([]sparsePresetView)
		if !ok || len(presets) != 1 || presets[0].ID != "preset-1" || presets[0].Name != "Backend" || len(presets[0].Directories) != 2 {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("sparsePresets.save", func(t *testing.T) {
		var gotReq *projectv1.SaveSparsePresetRequest
		fake.saveSparsePresetFunc = func(ctx context.Context, in *projectv1.SaveSparsePresetRequest) (*projectv1.SaveSparsePresetResponse, error) {
			gotReq = in
			return &projectv1.SaveSparsePresetResponse{Preset: &projectv1.SparsePreset{
				Id: "preset-2", RepoId: in.GetRepoId(), Name: in.GetName(), Directories: in.GetDirectories(),
			}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "sparsePresets.save",
			argsJSON(t, map[string]any{"repoId": "r1", "id": "", "name": "Frontend", "directories": []string{"web"}}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetName() != "Frontend" {
			t.Errorf("unexpected SaveSparsePresetRequest: %+v", gotReq)
		}
		preset, ok := result.(sparsePresetView)
		if !ok || preset.ID != "preset-2" || preset.Name != "Frontend" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("sparsePresets.remove", func(t *testing.T) {
		var gotReq *projectv1.RemoveSparsePresetRequest
		fake.removeSparsePresetFunc = func(ctx context.Context, in *projectv1.RemoveSparsePresetRequest) (*projectv1.RemoveSparsePresetResponse, error) {
			gotReq = in
			return &projectv1.RemoveSparsePresetResponse{}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "sparsePresets.remove",
			argsJSON(t, map[string]any{"repoId": "r1", "presetId": "preset-1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetRepoId() != "r1" || gotReq.GetPresetId() != "preset-1" {
			t.Errorf("unexpected RemoveSparsePresetRequest: %+v", gotReq)
		}
	})
}

// ── ssh.* ────────────────────────────────────────────────────────────────

func TestRegisterSshChannels(t *testing.T) {
	fake := &fakeRepoSshStatusWorkspaceInfraFleetClient{}
	r := NewRegistry()
	registerSshChannels(r, fake)

	t.Run("ssh.listTargets", func(t *testing.T) {
		fake.listSshTargetsFunc = func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error) {
			return &infrafleetv1.ListSshTargetsResponse{SshTargets: []*infrafleetv1.SshTarget{{Id: "s1", User: "root"}}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ssh.listTargets", nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		targets, ok := result.([]*infrafleetv1.SshTarget)
		if !ok || len(targets) != 1 || targets[0].GetId() != "s1" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("ssh.listTargets empty result returns [] not null (BUG-005)", func(t *testing.T) {
		fake.listSshTargetsFunc = func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error) {
			return &infrafleetv1.ListSshTargetsResponse{}, nil // SshTargets left nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ssh.listTargets", nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		b, err := json.Marshal(result)
		if err != nil {
			t.Fatalf("Marshal: %v", err)
		}
		if string(b) != "[]" {
			t.Errorf("expected [], got %s", b)
		}
	})

	t.Run("ssh.getUserAccount derives from ListSshTargets, filters by id", func(t *testing.T) {
		var listCalled bool
		fake.listSshTargetsFunc = func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error) {
			listCalled = true
			return &infrafleetv1.ListSshTargetsResponse{SshTargets: []*infrafleetv1.SshTarget{
				{Id: "s1", User: "root"},
				{Id: "s2", User: "ubuntu"},
			}}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ssh.getUserAccount",
			argsJSON(t, map[string]any{"sshTargetId": "s2"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !listCalled {
			t.Error("expected ssh.getUserAccount to call ListSshTargets, not a dedicated RPC")
		}
		account, ok := result.(map[string]string)
		if !ok || account["username"] != "ubuntu" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("ssh.getUserAccount not found", func(t *testing.T) {
		fake.listSshTargetsFunc = func(ctx context.Context, in *infrafleetv1.ListSshTargetsRequest) (*infrafleetv1.ListSshTargetsResponse, error) {
			return &infrafleetv1.ListSshTargetsResponse{}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ssh.getUserAccount",
			argsJSON(t, map[string]any{"sshTargetId": "missing"}))
		if err == nil {
			t.Fatal("expected error for unknown ssh target")
		}
	})

	t.Run("ssh.getState", func(t *testing.T) {
		var gotReq *infrafleetv1.GetSshStateRequest
		fake.getSshStateFunc = func(ctx context.Context, in *infrafleetv1.GetSshStateRequest) (*infrafleetv1.GetSshStateResponse, error) {
			gotReq = in
			return &infrafleetv1.GetSshStateResponse{Connected: true, ConnectionId: "c1"}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ssh.getState",
			argsJSON(t, map[string]any{"sshTargetId": "s1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetSshTargetId() != "s1" {
			t.Errorf("unexpected GetSshStateRequest: %+v", gotReq)
		}
	})

	t.Run("ssh.connect", func(t *testing.T) {
		var gotReq *infrafleetv1.EstablishConnectionRequest
		fake.establishConnectionFunc = func(ctx context.Context, in *infrafleetv1.EstablishConnectionRequest) (*infrafleetv1.Connection, error) {
			gotReq = in
			return &infrafleetv1.Connection{Id: "c1", Status: "established"}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ssh.connect",
			argsJSON(t, map[string]any{"sshTargetId": "s1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetSshTargetId() != "s1" {
			t.Errorf("unexpected EstablishConnectionRequest: %+v", gotReq)
		}
	})

	t.Run("ssh.connect propagates error", func(t *testing.T) {
		wantErr := errors.New("ssh handshake failed")
		fake.establishConnectionFunc = func(ctx context.Context, in *infrafleetv1.EstablishConnectionRequest) (*infrafleetv1.Connection, error) {
			return nil, wantErr
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "ssh.connect",
			argsJSON(t, map[string]any{"sshTargetId": "s1"}))
		if !errors.Is(err, wantErr) {
			t.Fatalf("want error %v, got %v", wantErr, err)
		}
	})
}

// ── status.get ───────────────────────────────────────────────────────────

func TestStatusGet_ReturnsHostPlatformAndHonestZeroValues(t *testing.T) {
	r := NewRegistry()
	registerStatusChannels(r)
	result, err := r.Dispatch(context.Background(), Identity{}, "status.get", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	m := result.(map[string]any)
	if m["hostPlatform"] == "" {
		t.Error("want non-empty hostPlatform")
	}
	if m["liveTabCount"] != 0 || m["authoritativeWindowId"] != nil {
		t.Error("want honest zero-values for window-graph fields, not fabricated data")
	}
	if _, ok := r.handlers["status.get"]; !ok {
		t.Error("expected status.get to be registered")
	}
}

// ── workspacePorts.* ─────────────────────────────────────────────────────

func TestRegisterWorkspacePortsChannels(t *testing.T) {
	fake := &fakeRepoSshStatusWorkspaceInfraFleetClient{}
	project := &fakeRepoProjectClient{}
	r := NewRegistry()
	registerWorkspacePortsChannels(r, project, fake)

	t.Run("workspacePorts.scan with an explicit connectionId passes it straight through, no resolution calls", func(t *testing.T) {
		var gotReq *infrafleetv1.ScanWorkspacePortsRequest
		fake.scanWorkspacePortsFunc = func(ctx context.Context, in *infrafleetv1.ScanWorkspacePortsRequest) (*infrafleetv1.ScanWorkspacePortsResponse, error) {
			gotReq = in
			return &infrafleetv1.ScanWorkspacePortsResponse{OpenPorts: []int32{3000, 8080}}, nil
		}
		// resolveConnectionFunc/getRepoFunc deliberately left nil — a set
		// connectionId must short-circuit before either would be called.
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "workspacePorts.scan",
			argsJSON(t, map[string]any{"connectionId": "c1", "worktreeId": "wt1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetConnectionId() != "c1" || gotReq.GetWorktreeId() != "wt1" {
			t.Errorf("unexpected ScanWorkspacePortsRequest: %+v", gotReq)
		}
		view, ok := result.(map[string]any)
		if !ok || view["platform"] != "unknown" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("workspacePorts.kill success with an explicit connectionId", func(t *testing.T) {
		var gotReq *infrafleetv1.KillWorkspacePortRequest
		fake.killWorkspacePortFunc = func(ctx context.Context, in *infrafleetv1.KillWorkspacePortRequest) (*infrafleetv1.KillWorkspacePortResponse, error) {
			gotReq = in
			return &infrafleetv1.KillWorkspacePortResponse{Ok: true}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "workspacePorts.kill",
			argsJSON(t, map[string]any{"connectionId": "c1", "worktreeId": "wt1", "pid": 123, "port": 8080}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetConnectionId() != "c1" || gotReq.GetPid() != 123 || gotReq.GetPort() != 8080 {
			t.Errorf("unexpected KillWorkspacePortRequest: %+v", gotReq)
		}
		m, ok := result.(map[string]any)
		if !ok || m["ok"] != true {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("workspacePorts.kill resolves worktreeId to a connectionId, then passes through the reason on failure", func(t *testing.T) {
		fake.resolveConnectionFunc = func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			if in.GetWorktreeId() != "wt1" {
				t.Fatalf("expected ResolveConnectionRequest.worktreeId=wt1, got %+v", in)
			}
			return &infrafleetv1.ResolveConnectionResponse{Connected: false}, nil
		}
		fake.killWorkspacePortFunc = func(ctx context.Context, in *infrafleetv1.KillWorkspacePortRequest) (*infrafleetv1.KillWorkspacePortResponse, error) {
			if in.GetConnectionId() != "" {
				t.Fatalf("expected empty connectionId for an unconnected worktree, got %q", in.GetConnectionId())
			}
			return &infrafleetv1.KillWorkspacePortResponse{Ok: false, Reason: "not implemented"}, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "workspacePorts.kill",
			argsJSON(t, map[string]any{"worktreeId": "wt1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		m, ok := result.(map[string]any)
		if !ok || m["ok"] != false || m["reason"] != "not implemented" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	// BUG-016: the real frontend caller sends {repoId} (scan) / {repoId, pid,
	// port} (kill), never {connectionId, worktreeId} — these two cases are
	// the actual reported bug, resolved via GetRepo+ListWorktrees+
	// ResolveConnection.
	t.Run("workspacePorts.scan resolves a real repoId to its single active worktree's connectionId", func(t *testing.T) {
		project.getRepoFunc = func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
			if in.GetRepoId() != "repo-1" {
				t.Fatalf("expected GetRepoRequest.repoId=repo-1, got %q", in.GetRepoId())
			}
			return &projectv1.GetRepoResponse{Repo: &projectv1.Repo{Id: "repo-1", ProjectId: "proj-1"}}, nil
		}
		project.listWorktreesFunc = func(ctx context.Context, in *projectv1.ListWorktreesRequest) (*projectv1.ListWorktreesResponse, error) {
			if in.GetProjectId() != "proj-1" {
				t.Fatalf("expected ListWorktreesRequest.projectId=proj-1, got %q", in.GetProjectId())
			}
			return &projectv1.ListWorktreesResponse{Worktrees: []*projectv1.Worktree{
				{Id: "wt-other-repo", RepoId: "repo-2", Active: true},
				{Id: "wt-inactive", RepoId: "repo-1", Active: false},
				{Id: "wt-active", RepoId: "repo-1", Active: true},
			}}, nil
		}
		fake.resolveConnectionFunc = func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			if in.GetWorktreeId() != "wt-active" {
				t.Fatalf("expected ResolveConnectionRequest.worktreeId=wt-active, got %+v", in)
			}
			return &infrafleetv1.ResolveConnectionResponse{Connected: true, ConnectionId: "conn-1"}, nil
		}
		var gotReq *infrafleetv1.ScanWorkspacePortsRequest
		fake.scanWorkspacePortsFunc = func(ctx context.Context, in *infrafleetv1.ScanWorkspacePortsRequest) (*infrafleetv1.ScanWorkspacePortsResponse, error) {
			gotReq = in
			return &infrafleetv1.ScanWorkspacePortsResponse{OpenPorts: []int32{4000}}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "workspacePorts.scan",
			argsJSON(t, map[string]any{"repoId": "repo-1"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetConnectionId() != "conn-1" || gotReq.GetWorktreeId() != "wt-active" {
			t.Errorf("unexpected ScanWorkspacePortsRequest: %+v", gotReq)
		}
	})

	t.Run("workspacePorts.kill: an explicit worktreeId wins over repoId (never calls GetRepo)", func(t *testing.T) {
		project.getRepoFunc = func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
			t.Fatal("GetRepo should not be called when worktreeId is already given")
			return nil, nil
		}
		fake.resolveConnectionFunc = func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			if in.GetWorktreeId() != "wt-direct" {
				t.Fatalf("expected worktreeId=wt-direct, got %+v", in)
			}
			return &infrafleetv1.ResolveConnectionResponse{Connected: true, ConnectionId: "conn-direct"}, nil
		}
		var gotReq *infrafleetv1.KillWorkspacePortRequest
		fake.killWorkspacePortFunc = func(ctx context.Context, in *infrafleetv1.KillWorkspacePortRequest) (*infrafleetv1.KillWorkspacePortResponse, error) {
			gotReq = in
			return &infrafleetv1.KillWorkspacePortResponse{Ok: true}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "workspacePorts.kill",
			argsJSON(t, map[string]any{"repoId": "repo-1", "worktreeId": "wt-direct", "pid": 1, "port": 2}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetConnectionId() != "conn-direct" {
			t.Errorf("unexpected KillWorkspacePortRequest: %+v", gotReq)
		}
	})

	t.Run("workspacePorts.scan: a repoId with zero worktrees degrades to the pre-existing empty-connectionId no-op", func(t *testing.T) {
		project.getRepoFunc = func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
			return &projectv1.GetRepoResponse{Repo: &projectv1.Repo{Id: "repo-lonely", ProjectId: "proj-2"}}, nil
		}
		project.listWorktreesFunc = func(ctx context.Context, in *projectv1.ListWorktreesRequest) (*projectv1.ListWorktreesResponse, error) {
			return &projectv1.ListWorktreesResponse{}, nil
		}
		var gotReq *infrafleetv1.ScanWorkspacePortsRequest
		fake.scanWorkspacePortsFunc = func(ctx context.Context, in *infrafleetv1.ScanWorkspacePortsRequest) (*infrafleetv1.ScanWorkspacePortsResponse, error) {
			gotReq = in
			return &infrafleetv1.ScanWorkspacePortsResponse{}, nil
		}
		// resolveConnectionFunc deliberately left unset (from the previous
		// subtest) to prove it's never reached — zero worktrees must short
		// circuit before any ResolveConnection call.
		fake.resolveConnectionFunc = func(ctx context.Context, in *infrafleetv1.ResolveConnectionRequest) (*infrafleetv1.ResolveConnectionResponse, error) {
			t.Fatal("ResolveConnection should not be called when the repo has zero worktrees")
			return nil, nil
		}
		result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "workspacePorts.scan",
			argsJSON(t, map[string]any{"repoId": "repo-lonely"}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetConnectionId() != "" || gotReq.GetWorktreeId() != "" {
			t.Errorf("expected empty connectionId/worktreeId, got %+v", gotReq)
		}
		view, ok := result.(map[string]any)
		if !ok || view["platform"] != "unknown" {
			t.Errorf("unexpected result: %+v", result)
		}
	})

	t.Run("workspacePorts.kill: multiple active worktrees for a repoId is ambiguous, degrades to the no-op rather than guessing", func(t *testing.T) {
		project.getRepoFunc = func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
			return &projectv1.GetRepoResponse{Repo: &projectv1.Repo{Id: "repo-multi", ProjectId: "proj-3"}}, nil
		}
		project.listWorktreesFunc = func(ctx context.Context, in *projectv1.ListWorktreesRequest) (*projectv1.ListWorktreesResponse, error) {
			return &projectv1.ListWorktreesResponse{Worktrees: []*projectv1.Worktree{
				{Id: "wt-a", RepoId: "repo-multi", Active: true},
				{Id: "wt-b", RepoId: "repo-multi", Active: true},
			}}, nil
		}
		var gotReq *infrafleetv1.KillWorkspacePortRequest
		fake.killWorkspacePortFunc = func(ctx context.Context, in *infrafleetv1.KillWorkspacePortRequest) (*infrafleetv1.KillWorkspacePortResponse, error) {
			gotReq = in
			return &infrafleetv1.KillWorkspacePortResponse{Ok: false, Reason: "not implemented"}, nil
		}
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "workspacePorts.kill",
			argsJSON(t, map[string]any{"repoId": "repo-multi", "pid": 1, "port": 2}))
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if gotReq.GetConnectionId() != "" || gotReq.GetWorktreeId() != "" {
			t.Errorf("expected empty connectionId/worktreeId for an ambiguous repo, got %+v", gotReq)
		}
	})

	if _, ok := r.handlers["workspacePorts.scan"]; !ok {
		t.Error("expected workspacePorts.scan to be registered")
	}
	if _, ok := r.handlers["workspacePorts.kill"]; !ok {
		t.Error("expected workspacePorts.kill to be registered")
	}
}

// ── resolveWorktreeIDForRepo / resolveWorkspacePortsConnection ────────────
//
// Direct unit coverage of the resolution helper's edge cases, complementing
// TestRegisterWorkspacePortsChannels' end-to-end Dispatch cases above.

func TestResolveWorktreeIDForRepo(t *testing.T) {
	t.Run("single worktree, none active, falls back to it", func(t *testing.T) {
		project := &fakeRepoProjectClient{
			getRepoFunc: func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
				return &projectv1.GetRepoResponse{Repo: &projectv1.Repo{Id: "r1", ProjectId: "p1"}}, nil
			},
			listWorktreesFunc: func(ctx context.Context, in *projectv1.ListWorktreesRequest) (*projectv1.ListWorktreesResponse, error) {
				return &projectv1.ListWorktreesResponse{Worktrees: []*projectv1.Worktree{{Id: "wt1", RepoId: "r1", Active: false}}}, nil
			},
		}
		got, err := resolveWorktreeIDForRepo(context.Background(), project, "r1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "wt1" {
			t.Errorf("want wt1, got %q", got)
		}
	})

	t.Run("repo has no project (not found / never assigned) -> empty, no ListWorktrees call", func(t *testing.T) {
		project := &fakeRepoProjectClient{
			getRepoFunc: func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
				return &projectv1.GetRepoResponse{Repo: &projectv1.Repo{Id: "r1"}}, nil
			},
			listWorktreesFunc: func(ctx context.Context, in *projectv1.ListWorktreesRequest) (*projectv1.ListWorktreesResponse, error) {
				t.Fatal("ListWorktrees should not be called when the repo has no projectId")
				return nil, nil
			},
		}
		got, err := resolveWorktreeIDForRepo(context.Background(), project, "r1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "" {
			t.Errorf("want empty, got %q", got)
		}
	})

	t.Run("GetRepo failure propagates", func(t *testing.T) {
		wantErr := errors.New("boom")
		project := &fakeRepoProjectClient{
			getRepoFunc: func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
				return nil, wantErr
			},
		}
		_, err := resolveWorktreeIDForRepo(context.Background(), project, "r1")
		if !errors.Is(err, wantErr) {
			t.Fatalf("expected GetRepo's error to propagate, got %v", err)
		}
	})

	t.Run("worktrees from other repos in the same project are ignored", func(t *testing.T) {
		project := &fakeRepoProjectClient{
			getRepoFunc: func(ctx context.Context, in *projectv1.GetRepoRequest) (*projectv1.GetRepoResponse, error) {
				return &projectv1.GetRepoResponse{Repo: &projectv1.Repo{Id: "r1", ProjectId: "p1"}}, nil
			},
			listWorktreesFunc: func(ctx context.Context, in *projectv1.ListWorktreesRequest) (*projectv1.ListWorktreesResponse, error) {
				return &projectv1.ListWorktreesResponse{Worktrees: []*projectv1.Worktree{
					{Id: "wt-other", RepoId: "r2", Active: true},
				}}, nil
			},
		}
		got, err := resolveWorktreeIDForRepo(context.Background(), project, "r1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "" {
			t.Errorf("want empty (no worktrees belong to r1), got %q", got)
		}
	})
}

// ── umbrella wiring ──────────────────────────────────────────────────────

func TestRegisterRepoSshStatusWorkspaceChannels_RegistersEverything(t *testing.T) {
	r := NewRegistry()
	registerRepoSshStatusWorkspaceChannels(r, &fakeRepoProjectClient{}, &fakeRepoGitGatewayClient{}, &fakeRepoSshStatusWorkspaceInfraFleetClient{})

	want := []string{
		"repo.add", "repo.list", "repo.reorder", "repo.rm", "repo.update", "repo.assignToProject", "repo.rebindDevServer",
		"repo.getMembers", "repo.addMember", "repo.removeMember", "repo.updateMemberRole",
		"repo.clone", "repo.baseRefDefault", "repo.searchRefs", "repo.create",
		"repo.hooksCheck", "repo.issueCommandRead", "repo.issueCommandWrite",
		"repo.setupScriptImports",
		"ssh.listTargets", "ssh.getUserAccount", "ssh.getState", "ssh.connect",
		"status.get",
		"workspacePorts.scan", "workspacePorts.kill",
	}
	for _, channel := range want {
		if _, ok := r.handlers[channel]; !ok {
			t.Errorf("expected channel %q to be registered", channel)
		}
	}
}
