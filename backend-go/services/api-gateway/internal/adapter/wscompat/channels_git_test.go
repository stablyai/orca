package wscompat

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/protobuf/types/known/emptypb"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
)

// fakeGitGatewayClient implements gitgatewayv1.GitGatewayServiceClient over
// per-method hook functions — embeds the (nil) interface so unset methods
// panic loudly if a test reaches one it didn't mean to exercise, mirroring
// this package's existing fakeInfraFleetClient convention (channels_test.go).
type fakeGitGatewayClient struct {
	gitgatewayv1.GitGatewayServiceClient

	getDiffFunc                     func(ctx context.Context, in *gitgatewayv1.GetDiffRequest) (*gitgatewayv1.GetDiffResponse, error)
	commitFunc                      func(ctx context.Context, in *gitgatewayv1.CommitRequest) (*gitgatewayv1.CommitResponse, error)
	pushFunc                        func(ctx context.Context, in *gitgatewayv1.PushRequest) (*gitgatewayv1.PushResponse, error)
	pullFunc                        func(ctx context.Context, in *gitgatewayv1.PullRequest) (*gitgatewayv1.PullResponse, error)
	generateCommitMessageFunc       func(ctx context.Context, in *gitgatewayv1.GenerateCommitMessageRequest) (*gitgatewayv1.GenerateCommitMessageResponse, error)
	stageFunc                       func(ctx context.Context, in *gitgatewayv1.StageRequest) (*gitgatewayv1.StageResponse, error)
	unstageFunc                     func(ctx context.Context, in *gitgatewayv1.UnstageRequest) (*gitgatewayv1.UnstageResponse, error)
	historyFunc                     func(ctx context.Context, in *gitgatewayv1.HistoryRequest) (*gitgatewayv1.HistoryResponse, error)
	checkIgnoredFunc                func(ctx context.Context, in *gitgatewayv1.CheckIgnoredRequest) (*gitgatewayv1.CheckIgnoredResponse, error)
	forkSyncFunc                    func(ctx context.Context, in *gitgatewayv1.ForkSyncRequest) (*gitgatewayv1.ForkSyncResponse, error)
	upstreamStatusFunc              func(ctx context.Context, in *gitgatewayv1.UpstreamStatusRequest) (*gitgatewayv1.UpstreamStatusResponse, error)
	remoteCommitURLFunc             func(ctx context.Context, in *gitgatewayv1.RemoteCommitUrlRequest) (*gitgatewayv1.RemoteUrlResponse, error)
	remoteFileURLFunc               func(ctx context.Context, in *gitgatewayv1.RemoteFileUrlRequest) (*gitgatewayv1.RemoteUrlResponse, error)
	generatePullRequestFieldsFunc   func(ctx context.Context, in *gitgatewayv1.GeneratePullRequestFieldsRequest) (*gitgatewayv1.GeneratePullRequestFieldsResponse, error)
	discoverCommitMessageModelsFunc func(ctx context.Context, in *gitgatewayv1.DiscoverCommitMessageModelsRequest) (*gitgatewayv1.DiscoverCommitMessageModelsResponse, error)
	readFileFunc                    func(ctx context.Context, in *gitgatewayv1.ReadFileRequest) (*gitgatewayv1.ReadFileResponse, error)
	writeFileFunc                   func(ctx context.Context, in *gitgatewayv1.WriteFileRequest) (*gitgatewayv1.WriteFileResponse, error)
	renameFileFunc                  func(ctx context.Context, in *gitgatewayv1.RenameFileRequest) (*gitgatewayv1.RenameFileResponse, error)
	statFileFunc                    func(ctx context.Context, in *gitgatewayv1.StatFileRequest) (*gitgatewayv1.StatFileResponse, error)
	readDirFunc                     func(ctx context.Context, in *gitgatewayv1.ReadDirRequest) (*gitgatewayv1.ReadDirResponse, error)
	readFileChunkFunc               func(ctx context.Context, in *gitgatewayv1.ReadFileChunkRequest) (*gitgatewayv1.ReadFileChunkResponse, error)
	readFilePreviewFunc             func(ctx context.Context, in *gitgatewayv1.ReadFilePreviewRequest) (*gitgatewayv1.ReadFilePreviewResponse, error)
	writeFileChunkFunc              func(ctx context.Context, in *gitgatewayv1.WriteFileChunkRequest) (*gitgatewayv1.WriteFileChunkResponse, error)
	createDirFunc                   func(ctx context.Context, in *gitgatewayv1.CreateDirRequest) (*gitgatewayv1.CreateDirResponse, error)
	createFileFunc                  func(ctx context.Context, in *gitgatewayv1.CreateFileRequest) (*gitgatewayv1.CreateFileResponse, error)
	deleteFileFunc                  func(ctx context.Context, in *gitgatewayv1.DeleteFileRequest) (*emptypb.Empty, error)
	searchFilesFunc                 func(ctx context.Context, in *gitgatewayv1.SearchFilesRequest) (*gitgatewayv1.SearchFilesResponse, error)
	listAllFilesFunc                func(ctx context.Context, in *gitgatewayv1.ListAllFilesRequest) (*gitgatewayv1.ListAllFilesResponse, error)
	listMarkdownDocumentsFunc       func(ctx context.Context, in *gitgatewayv1.ListMarkdownDocumentsRequest) (*gitgatewayv1.ListMarkdownDocumentsResponse, error)
	copyFileFunc                    func(ctx context.Context, in *gitgatewayv1.CopyFileRequest) (*gitgatewayv1.CopyFileResponse, error)
	getRemoteUrlFunc                func(ctx context.Context, in *gitgatewayv1.GetRemoteUrlRequest) (*gitgatewayv1.GetRemoteUrlResponse, error)

	checkoutFunc          func(ctx context.Context, in *gitgatewayv1.CheckoutRequest) (*gitgatewayv1.CheckoutResponse, error)
	listLocalBranchesFunc func(ctx context.Context, in *gitgatewayv1.ListLocalBranchesRequest) (*gitgatewayv1.ListLocalBranchesResponse, error)
	fastForwardFunc       func(ctx context.Context, in *gitgatewayv1.FastForwardRequest) (*gitgatewayv1.FastForwardResponse, error)
	rebaseFromBaseFunc    func(ctx context.Context, in *gitgatewayv1.RebaseFromBaseRequest) (*gitgatewayv1.RebaseFromBaseResponse, error)
	abortRebaseFunc       func(ctx context.Context, in *gitgatewayv1.AbortRebaseRequest) (*gitgatewayv1.AbortRebaseResponse, error)
	abortMergeFunc        func(ctx context.Context, in *gitgatewayv1.AbortMergeRequest) (*gitgatewayv1.AbortMergeResponse, error)
	conflictOperationFunc func(ctx context.Context, in *gitgatewayv1.ConflictOperationRequest) (*gitgatewayv1.ConflictOperationResponse, error)
	resolveConflictFunc   func(ctx context.Context, in *gitgatewayv1.ResolveConflictRequest) (*gitgatewayv1.ResolveConflictResponse, error)
	discardFunc           func(ctx context.Context, in *gitgatewayv1.DiscardRequest) (*gitgatewayv1.DiscardResponse, error)
	bulkDiscardFunc       func(ctx context.Context, in *gitgatewayv1.BulkDiscardRequest) (*gitgatewayv1.BulkDiscardResponse, error)

	commitCompareFunc   func(ctx context.Context, in *gitgatewayv1.CommitCompareRequest) (*gitgatewayv1.CommitCompareResponse, error)
	branchCompareFunc   func(ctx context.Context, in *gitgatewayv1.BranchCompareRequest) (*gitgatewayv1.BranchCompareResponse, error)
	commitDiffFunc      func(ctx context.Context, in *gitgatewayv1.CommitDiffRequest) (*gitgatewayv1.FileDiffResponse, error)
	branchDiffFunc      func(ctx context.Context, in *gitgatewayv1.BranchDiffRequest) (*gitgatewayv1.FileDiffResponse, error)
	submoduleStatusFunc func(ctx context.Context, in *gitgatewayv1.SubmoduleStatusRequest) (*gitgatewayv1.GetStatusResponse, error)
	fetchFunc           func(ctx context.Context, in *gitgatewayv1.FetchRequest) (*gitgatewayv1.FetchResponse, error)
	getStatusFunc       func(ctx context.Context, in *gitgatewayv1.GetStatusRequest) (*gitgatewayv1.GetStatusResponse, error)
}

func (f *fakeGitGatewayClient) CommitCompare(ctx context.Context, in *gitgatewayv1.CommitCompareRequest, _ ...grpc.CallOption) (*gitgatewayv1.CommitCompareResponse, error) {
	return f.commitCompareFunc(ctx, in)
}
func (f *fakeGitGatewayClient) BranchCompare(ctx context.Context, in *gitgatewayv1.BranchCompareRequest, _ ...grpc.CallOption) (*gitgatewayv1.BranchCompareResponse, error) {
	return f.branchCompareFunc(ctx, in)
}
func (f *fakeGitGatewayClient) CommitDiff(ctx context.Context, in *gitgatewayv1.CommitDiffRequest, _ ...grpc.CallOption) (*gitgatewayv1.FileDiffResponse, error) {
	return f.commitDiffFunc(ctx, in)
}
func (f *fakeGitGatewayClient) BranchDiff(ctx context.Context, in *gitgatewayv1.BranchDiffRequest, _ ...grpc.CallOption) (*gitgatewayv1.FileDiffResponse, error) {
	return f.branchDiffFunc(ctx, in)
}
func (f *fakeGitGatewayClient) SubmoduleStatus(ctx context.Context, in *gitgatewayv1.SubmoduleStatusRequest, _ ...grpc.CallOption) (*gitgatewayv1.GetStatusResponse, error) {
	return f.submoduleStatusFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Fetch(ctx context.Context, in *gitgatewayv1.FetchRequest, _ ...grpc.CallOption) (*gitgatewayv1.FetchResponse, error) {
	return f.fetchFunc(ctx, in)
}
func (f *fakeGitGatewayClient) GetStatus(ctx context.Context, in *gitgatewayv1.GetStatusRequest, _ ...grpc.CallOption) (*gitgatewayv1.GetStatusResponse, error) {
	return f.getStatusFunc(ctx, in)
}

func (f *fakeGitGatewayClient) GetDiff(ctx context.Context, in *gitgatewayv1.GetDiffRequest, _ ...grpc.CallOption) (*gitgatewayv1.GetDiffResponse, error) {
	return f.getDiffFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Commit(ctx context.Context, in *gitgatewayv1.CommitRequest, _ ...grpc.CallOption) (*gitgatewayv1.CommitResponse, error) {
	return f.commitFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Push(ctx context.Context, in *gitgatewayv1.PushRequest, _ ...grpc.CallOption) (*gitgatewayv1.PushResponse, error) {
	return f.pushFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Pull(ctx context.Context, in *gitgatewayv1.PullRequest, _ ...grpc.CallOption) (*gitgatewayv1.PullResponse, error) {
	return f.pullFunc(ctx, in)
}
func (f *fakeGitGatewayClient) GenerateCommitMessage(ctx context.Context, in *gitgatewayv1.GenerateCommitMessageRequest, _ ...grpc.CallOption) (*gitgatewayv1.GenerateCommitMessageResponse, error) {
	return f.generateCommitMessageFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Unstage(ctx context.Context, in *gitgatewayv1.UnstageRequest, _ ...grpc.CallOption) (*gitgatewayv1.UnstageResponse, error) {
	return f.unstageFunc(ctx, in)
}
func (f *fakeGitGatewayClient) UpstreamStatus(ctx context.Context, in *gitgatewayv1.UpstreamStatusRequest, _ ...grpc.CallOption) (*gitgatewayv1.UpstreamStatusResponse, error) {
	return f.upstreamStatusFunc(ctx, in)
}
func (f *fakeGitGatewayClient) RemoteFileUrl(ctx context.Context, in *gitgatewayv1.RemoteFileUrlRequest, _ ...grpc.CallOption) (*gitgatewayv1.RemoteUrlResponse, error) {
	return f.remoteFileURLFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Stage(ctx context.Context, in *gitgatewayv1.StageRequest, _ ...grpc.CallOption) (*gitgatewayv1.StageResponse, error) {
	return f.stageFunc(ctx, in)
}
func (f *fakeGitGatewayClient) History(ctx context.Context, in *gitgatewayv1.HistoryRequest, _ ...grpc.CallOption) (*gitgatewayv1.HistoryResponse, error) {
	return f.historyFunc(ctx, in)
}
func (f *fakeGitGatewayClient) CheckIgnored(ctx context.Context, in *gitgatewayv1.CheckIgnoredRequest, _ ...grpc.CallOption) (*gitgatewayv1.CheckIgnoredResponse, error) {
	return f.checkIgnoredFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ForkSync(ctx context.Context, in *gitgatewayv1.ForkSyncRequest, _ ...grpc.CallOption) (*gitgatewayv1.ForkSyncResponse, error) {
	return f.forkSyncFunc(ctx, in)
}
func (f *fakeGitGatewayClient) RemoteCommitUrl(ctx context.Context, in *gitgatewayv1.RemoteCommitUrlRequest, _ ...grpc.CallOption) (*gitgatewayv1.RemoteUrlResponse, error) {
	return f.remoteCommitURLFunc(ctx, in)
}
func (f *fakeGitGatewayClient) GeneratePullRequestFields(ctx context.Context, in *gitgatewayv1.GeneratePullRequestFieldsRequest, _ ...grpc.CallOption) (*gitgatewayv1.GeneratePullRequestFieldsResponse, error) {
	return f.generatePullRequestFieldsFunc(ctx, in)
}
func (f *fakeGitGatewayClient) DiscoverCommitMessageModels(ctx context.Context, in *gitgatewayv1.DiscoverCommitMessageModelsRequest, _ ...grpc.CallOption) (*gitgatewayv1.DiscoverCommitMessageModelsResponse, error) {
	return f.discoverCommitMessageModelsFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ReadFile(ctx context.Context, in *gitgatewayv1.ReadFileRequest, _ ...grpc.CallOption) (*gitgatewayv1.ReadFileResponse, error) {
	return f.readFileFunc(ctx, in)
}
func (f *fakeGitGatewayClient) WriteFile(ctx context.Context, in *gitgatewayv1.WriteFileRequest, _ ...grpc.CallOption) (*gitgatewayv1.WriteFileResponse, error) {
	return f.writeFileFunc(ctx, in)
}
func (f *fakeGitGatewayClient) RenameFile(ctx context.Context, in *gitgatewayv1.RenameFileRequest, _ ...grpc.CallOption) (*gitgatewayv1.RenameFileResponse, error) {
	return f.renameFileFunc(ctx, in)
}
func (f *fakeGitGatewayClient) StatFile(ctx context.Context, in *gitgatewayv1.StatFileRequest, _ ...grpc.CallOption) (*gitgatewayv1.StatFileResponse, error) {
	return f.statFileFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ReadDir(ctx context.Context, in *gitgatewayv1.ReadDirRequest, _ ...grpc.CallOption) (*gitgatewayv1.ReadDirResponse, error) {
	return f.readDirFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ReadFileChunk(ctx context.Context, in *gitgatewayv1.ReadFileChunkRequest, _ ...grpc.CallOption) (*gitgatewayv1.ReadFileChunkResponse, error) {
	return f.readFileChunkFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ReadFilePreview(ctx context.Context, in *gitgatewayv1.ReadFilePreviewRequest, _ ...grpc.CallOption) (*gitgatewayv1.ReadFilePreviewResponse, error) {
	return f.readFilePreviewFunc(ctx, in)
}
func (f *fakeGitGatewayClient) WriteFileChunk(ctx context.Context, in *gitgatewayv1.WriteFileChunkRequest, _ ...grpc.CallOption) (*gitgatewayv1.WriteFileChunkResponse, error) {
	return f.writeFileChunkFunc(ctx, in)
}
func (f *fakeGitGatewayClient) CreateDir(ctx context.Context, in *gitgatewayv1.CreateDirRequest, _ ...grpc.CallOption) (*gitgatewayv1.CreateDirResponse, error) {
	return f.createDirFunc(ctx, in)
}
func (f *fakeGitGatewayClient) CreateFile(ctx context.Context, in *gitgatewayv1.CreateFileRequest, _ ...grpc.CallOption) (*gitgatewayv1.CreateFileResponse, error) {
	return f.createFileFunc(ctx, in)
}
func (f *fakeGitGatewayClient) DeleteFile(ctx context.Context, in *gitgatewayv1.DeleteFileRequest, _ ...grpc.CallOption) (*emptypb.Empty, error) {
	return f.deleteFileFunc(ctx, in)
}
func (f *fakeGitGatewayClient) SearchFiles(ctx context.Context, in *gitgatewayv1.SearchFilesRequest, _ ...grpc.CallOption) (*gitgatewayv1.SearchFilesResponse, error) {
	return f.searchFilesFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ListAllFiles(ctx context.Context, in *gitgatewayv1.ListAllFilesRequest, _ ...grpc.CallOption) (*gitgatewayv1.ListAllFilesResponse, error) {
	return f.listAllFilesFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ListMarkdownDocuments(ctx context.Context, in *gitgatewayv1.ListMarkdownDocumentsRequest, _ ...grpc.CallOption) (*gitgatewayv1.ListMarkdownDocumentsResponse, error) {
	return f.listMarkdownDocumentsFunc(ctx, in)
}
func (f *fakeGitGatewayClient) CopyFile(ctx context.Context, in *gitgatewayv1.CopyFileRequest, _ ...grpc.CallOption) (*gitgatewayv1.CopyFileResponse, error) {
	return f.copyFileFunc(ctx, in)
}
func (f *fakeGitGatewayClient) GetRemoteUrl(ctx context.Context, in *gitgatewayv1.GetRemoteUrlRequest, _ ...grpc.CallOption) (*gitgatewayv1.GetRemoteUrlResponse, error) {
	return f.getRemoteUrlFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Checkout(ctx context.Context, in *gitgatewayv1.CheckoutRequest, _ ...grpc.CallOption) (*gitgatewayv1.CheckoutResponse, error) {
	return f.checkoutFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ListLocalBranches(ctx context.Context, in *gitgatewayv1.ListLocalBranchesRequest, _ ...grpc.CallOption) (*gitgatewayv1.ListLocalBranchesResponse, error) {
	return f.listLocalBranchesFunc(ctx, in)
}
func (f *fakeGitGatewayClient) FastForward(ctx context.Context, in *gitgatewayv1.FastForwardRequest, _ ...grpc.CallOption) (*gitgatewayv1.FastForwardResponse, error) {
	return f.fastForwardFunc(ctx, in)
}
func (f *fakeGitGatewayClient) RebaseFromBase(ctx context.Context, in *gitgatewayv1.RebaseFromBaseRequest, _ ...grpc.CallOption) (*gitgatewayv1.RebaseFromBaseResponse, error) {
	return f.rebaseFromBaseFunc(ctx, in)
}
func (f *fakeGitGatewayClient) AbortRebase(ctx context.Context, in *gitgatewayv1.AbortRebaseRequest, _ ...grpc.CallOption) (*gitgatewayv1.AbortRebaseResponse, error) {
	return f.abortRebaseFunc(ctx, in)
}
func (f *fakeGitGatewayClient) AbortMerge(ctx context.Context, in *gitgatewayv1.AbortMergeRequest, _ ...grpc.CallOption) (*gitgatewayv1.AbortMergeResponse, error) {
	return f.abortMergeFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ConflictOperation(ctx context.Context, in *gitgatewayv1.ConflictOperationRequest, _ ...grpc.CallOption) (*gitgatewayv1.ConflictOperationResponse, error) {
	return f.conflictOperationFunc(ctx, in)
}
func (f *fakeGitGatewayClient) ResolveConflict(ctx context.Context, in *gitgatewayv1.ResolveConflictRequest, _ ...grpc.CallOption) (*gitgatewayv1.ResolveConflictResponse, error) {
	return f.resolveConflictFunc(ctx, in)
}
func (f *fakeGitGatewayClient) Discard(ctx context.Context, in *gitgatewayv1.DiscardRequest, _ ...grpc.CallOption) (*gitgatewayv1.DiscardResponse, error) {
	return f.discardFunc(ctx, in)
}
func (f *fakeGitGatewayClient) BulkDiscard(ctx context.Context, in *gitgatewayv1.BulkDiscardRequest, _ ...grpc.CallOption) (*gitgatewayv1.BulkDiscardResponse, error) {
	return f.bulkDiscardFunc(ctx, in)
}

func TestGitDiffChannel_ThreadsFilePathThrough(t *testing.T) {
	var got *gitgatewayv1.GetDiffRequest
	fake := &fakeGitGatewayClient{
		getDiffFunc: func(ctx context.Context, in *gitgatewayv1.GetDiffRequest) (*gitgatewayv1.GetDiffResponse, error) {
			got = in
			return &gitgatewayv1.GetDiffResponse{UnifiedDiff: "diff"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.diff",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "filePath": "a.txt", "staged": true}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetWorktreeId() != "wt-1" || got.GetFilePath() != "a.txt" || !got.GetStaged() {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitCommitChannel_Success(t *testing.T) {
	fake := &fakeGitGatewayClient{
		commitFunc: func(ctx context.Context, in *gitgatewayv1.CommitRequest) (*gitgatewayv1.CommitResponse, error) {
			return &gitgatewayv1.CommitResponse{CommitSha: "abc123"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.commit",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "message": "fix"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*gitgatewayv1.CommitResponse)
	if !ok || resp.GetCommitSha() != "abc123" {
		t.Errorf("unexpected result: %+v", result)
	}
}

// ── TASK-207/TASK-212: Group A — branch/ref operations ─────────────────────

func TestGitCheckoutChannel_NoCreateField(t *testing.T) {
	var got *gitgatewayv1.CheckoutRequest
	fake := &fakeGitGatewayClient{
		checkoutFunc: func(ctx context.Context, in *gitgatewayv1.CheckoutRequest) (*gitgatewayv1.CheckoutResponse, error) {
			got = in
			return &gitgatewayv1.CheckoutResponse{Success: true, Branch: "feature"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	// Sending a "create" field (the stale TASK-212 sketch's shape) must be
	// harmlessly ignored — the redesigned args struct has no such field.
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.checkout",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "branch": "feature", "create": true}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetWorktreeId() != "wt-1" || got.GetBranch() != "feature" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitLocalBranchesChannel_ReturnsUnwrappedBranches(t *testing.T) {
	fake := &fakeGitGatewayClient{
		listLocalBranchesFunc: func(ctx context.Context, in *gitgatewayv1.ListLocalBranchesRequest) (*gitgatewayv1.ListLocalBranchesResponse, error) {
			return &gitgatewayv1.ListLocalBranchesResponse{
				Branches: []*gitgatewayv1.BranchInfo{{Name: "main", IsCurrent: true}},
			}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.localBranches",
		argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	branches, ok := result.([]*gitgatewayv1.BranchInfo)
	if !ok || len(branches) != 1 || branches[0].GetName() != "main" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestGitFastForwardChannel_ThreadsStructuredPushTarget(t *testing.T) {
	var got *gitgatewayv1.FastForwardRequest
	fake := &fakeGitGatewayClient{
		fastForwardFunc: func(ctx context.Context, in *gitgatewayv1.FastForwardRequest) (*gitgatewayv1.FastForwardResponse, error) {
			got = in
			return &gitgatewayv1.FastForwardResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.fastForward",
		argsJSON(t, map[string]any{
			"worktreeId": "wt-1",
			"pushTarget": map[string]any{"remoteName": "origin", "branchName": "main"},
		}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetWorktreeId() != "wt-1" || got.GetPushTarget().GetRemoteName() != "origin" || got.GetPushTarget().GetBranchName() != "main" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitFastForwardChannel_NilPushTarget_Allowed(t *testing.T) {
	var got *gitgatewayv1.FastForwardRequest
	fake := &fakeGitGatewayClient{
		fastForwardFunc: func(ctx context.Context, in *gitgatewayv1.FastForwardRequest) (*gitgatewayv1.FastForwardResponse, error) {
			got = in
			return &gitgatewayv1.FastForwardResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.fastForward",
		argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetPushTarget() != nil {
		t.Errorf("expected nil push target, got %+v", got.GetPushTarget())
	}
}

func TestGitRebaseFromBaseChannel_Success(t *testing.T) {
	fake := &fakeGitGatewayClient{
		rebaseFromBaseFunc: func(ctx context.Context, in *gitgatewayv1.RebaseFromBaseRequest) (*gitgatewayv1.RebaseFromBaseResponse, error) {
			if in.GetBaseBranch() != "main" {
				t.Errorf("expected baseBranch=main, got %q", in.GetBaseBranch())
			}
			return &gitgatewayv1.RebaseFromBaseResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.rebaseFromBase",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "baseBranch": "main"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGitAbortRebaseAndAbortMergeChannels_Success(t *testing.T) {
	fake := &fakeGitGatewayClient{
		abortRebaseFunc: func(ctx context.Context, in *gitgatewayv1.AbortRebaseRequest) (*gitgatewayv1.AbortRebaseResponse, error) {
			return &gitgatewayv1.AbortRebaseResponse{Success: true}, nil
		},
		abortMergeFunc: func(ctx context.Context, in *gitgatewayv1.AbortMergeRequest) (*gitgatewayv1.AbortMergeResponse, error) {
			return &gitgatewayv1.AbortMergeResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	for _, channel := range []string{"git.abortRebase", "git.abortMerge"} {
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, channel,
			argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", channel, err)
		}
	}
}

func TestGitConflictOperationChannel_IsDetectorOnly(t *testing.T) {
	var got *gitgatewayv1.ConflictOperationRequest
	fake := &fakeGitGatewayClient{
		conflictOperationFunc: func(ctx context.Context, in *gitgatewayv1.ConflictOperationRequest) (*gitgatewayv1.ConflictOperationResponse, error) {
			got = in
			return &gitgatewayv1.ConflictOperationResponse{Operation: "rebase"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	// Sending path/operation (the stale TASK-212 sketch's shape) must be
	// harmlessly ignored — the redesigned args struct has no such fields.
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.conflictOperation",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "operation": "ours"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetWorktreeId() != "wt-1" {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.ConflictOperationResponse)
	if !ok || resp.GetOperation() != "rebase" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestGitResolveConflictChannel_Success(t *testing.T) {
	var got *gitgatewayv1.ResolveConflictRequest
	fake := &fakeGitGatewayClient{
		resolveConflictFunc: func(ctx context.Context, in *gitgatewayv1.ResolveConflictRequest) (*gitgatewayv1.ResolveConflictResponse, error) {
			got = in
			return &gitgatewayv1.ResolveConflictResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.resolveConflict",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "operation": "ours"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetPath() != "a.txt" || got.GetOperation() != "ours" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitResolveConflictChannel_UnsupportedOverRelay_ErrorPassesThrough(t *testing.T) {
	wantErr := errors.New("failed_precondition: relay target does not support per-file conflict resolution")
	fake := &fakeGitGatewayClient{
		resolveConflictFunc: func(ctx context.Context, in *gitgatewayv1.ResolveConflictRequest) (*gitgatewayv1.ResolveConflictResponse, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.resolveConflict",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "operation": "ours"}))
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected the FAILED_PRECONDITION error to pass through, got %v", err)
	}
}

func TestGitDiscardAndBulkDiscardChannels_Success(t *testing.T) {
	fake := &fakeGitGatewayClient{
		discardFunc: func(ctx context.Context, in *gitgatewayv1.DiscardRequest) (*gitgatewayv1.DiscardResponse, error) {
			return &gitgatewayv1.DiscardResponse{Success: true}, nil
		},
		bulkDiscardFunc: func(ctx context.Context, in *gitgatewayv1.BulkDiscardRequest) (*gitgatewayv1.BulkDiscardResponse, error) {
			return &gitgatewayv1.BulkDiscardResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.discard",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt"})); err != nil {
		t.Fatalf("git.discard: unexpected error: %v", err)
	}
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.bulkDiscard",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "paths": []string{"a.txt", "b.txt"}})); err != nil {
		t.Fatalf("git.bulkDiscard: unexpected error: %v", err)
	}
}

func TestGitStageAndBulkStageChannels_ShareOneHandler(t *testing.T) {
	var callCount int
	fake := &fakeGitGatewayClient{
		stageFunc: func(ctx context.Context, in *gitgatewayv1.StageRequest) (*gitgatewayv1.StageResponse, error) {
			callCount++
			return &gitgatewayv1.StageResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	for _, channel := range []string{"git.stage", "git.bulkStage"} {
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, channel,
			argsJSON(t, map[string]any{"worktreeId": "wt-1", "paths": []string{"a.txt"}}))
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", channel, err)
		}
	}
	if callCount != 2 {
		t.Errorf("expected both channels to reach Stage, got %d calls", callCount)
	}
}

func TestGitHistoryChannel_CorrectedShape(t *testing.T) {
	var got *gitgatewayv1.HistoryRequest
	fake := &fakeGitGatewayClient{
		historyFunc: func(ctx context.Context, in *gitgatewayv1.HistoryRequest) (*gitgatewayv1.HistoryResponse, error) {
			got = in
			return &gitgatewayv1.HistoryResponse{}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	// baseRef (not "ref"), no cursor — matches TASK-209's corrected shape.
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.history",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "baseRef": "main", "limit": 5}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetBaseRef() != "main" || got.GetLimit() != 5 {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitDiscoverCommitMessageModelsChannel_UsesIdentityNotArgs(t *testing.T) {
	var got *gitgatewayv1.DiscoverCommitMessageModelsRequest
	fake := &fakeGitGatewayClient{
		discoverCommitMessageModelsFunc: func(ctx context.Context, in *gitgatewayv1.DiscoverCommitMessageModelsRequest) (*gitgatewayv1.DiscoverCommitMessageModelsResponse, error) {
			got = in
			return &gitgatewayv1.DiscoverCommitMessageModelsResponse{}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "tenant-1", UserID: "user-1"}, "git.discoverCommitMessageModels", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetTenantId() != "tenant-1" || got.GetUserId() != "user-1" {
		t.Errorf("expected tenant/user sourced from Identity (never a client-supplied arg), got %+v", got)
	}
}

func TestGitPushChannel_Success(t *testing.T) {
	var got *gitgatewayv1.PushRequest
	fake := &fakeGitGatewayClient{
		pushFunc: func(ctx context.Context, in *gitgatewayv1.PushRequest) (*gitgatewayv1.PushResponse, error) {
			got = in
			return &gitgatewayv1.PushResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.push",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "remote": "origin", "branch": "main"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetRemote() != "origin" || got.GetBranch() != "main" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitPullChannel_Success(t *testing.T) {
	var got *gitgatewayv1.PullRequest
	fake := &fakeGitGatewayClient{
		pullFunc: func(ctx context.Context, in *gitgatewayv1.PullRequest) (*gitgatewayv1.PullResponse, error) {
			got = in
			return &gitgatewayv1.PullResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.pull",
		argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetWorktreeId() != "wt-1" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitGenerateCommitMessageChannel_Success(t *testing.T) {
	fake := &fakeGitGatewayClient{
		generateCommitMessageFunc: func(ctx context.Context, in *gitgatewayv1.GenerateCommitMessageRequest) (*gitgatewayv1.GenerateCommitMessageResponse, error) {
			return &gitgatewayv1.GenerateCommitMessageResponse{Message: "fix bug"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.generateCommitMessage",
		argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*gitgatewayv1.GenerateCommitMessageResponse)
	if !ok || resp.GetMessage() != "fix bug" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestGitUnstageAndBulkUnstageChannels_ShareOneHandler(t *testing.T) {
	var callCount int
	fake := &fakeGitGatewayClient{
		unstageFunc: func(ctx context.Context, in *gitgatewayv1.UnstageRequest) (*gitgatewayv1.UnstageResponse, error) {
			callCount++
			return &gitgatewayv1.UnstageResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	for _, channel := range []string{"git.unstage", "git.bulkUnstage"} {
		_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, channel,
			argsJSON(t, map[string]any{"worktreeId": "wt-1", "paths": []string{"a.txt"}}))
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", channel, err)
		}
	}
	if callCount != 2 {
		t.Errorf("expected both channels to reach Unstage, got %d calls", callCount)
	}
}

func TestGitCheckIgnoredChannel_ReturnsUnwrappedIgnoredPaths(t *testing.T) {
	fake := &fakeGitGatewayClient{
		checkIgnoredFunc: func(ctx context.Context, in *gitgatewayv1.CheckIgnoredRequest) (*gitgatewayv1.CheckIgnoredResponse, error) {
			if len(in.GetPaths()) != 2 {
				t.Errorf("unexpected request: %+v", in)
			}
			return &gitgatewayv1.CheckIgnoredResponse{IgnoredPaths: []string{"node_modules"}}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.checkIgnored",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "paths": []string{"node_modules", "README.md"}}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	paths, ok := result.([]string)
	if !ok || len(paths) != 1 || paths[0] != "node_modules" {
		t.Errorf("expected unwrapped ignored-subset slice, got %+v", result)
	}
}

func TestGitForkSyncChannel_SendsExpectedUpstream(t *testing.T) {
	var got *gitgatewayv1.ForkSyncRequest
	fake := &fakeGitGatewayClient{
		forkSyncFunc: func(ctx context.Context, in *gitgatewayv1.ForkSyncRequest) (*gitgatewayv1.ForkSyncResponse, error) {
			got = in
			return &gitgatewayv1.ForkSyncResponse{Ahead: 1, Behind: 2}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.forkSync",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "expectedUpstream": "origin/main"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetExpectedUpstream() != "origin/main" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitUpstreamStatusChannel_SendsStructuredPushTarget(t *testing.T) {
	var got *gitgatewayv1.UpstreamStatusRequest
	fake := &fakeGitGatewayClient{
		upstreamStatusFunc: func(ctx context.Context, in *gitgatewayv1.UpstreamStatusRequest) (*gitgatewayv1.UpstreamStatusResponse, error) {
			got = in
			return &gitgatewayv1.UpstreamStatusResponse{HasUpstream: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.upstreamStatus",
		argsJSON(t, map[string]any{
			"worktreeId": "wt-1",
			"pushTarget": map[string]any{"remoteName": "origin", "branchName": "main"},
		}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetPushTarget().GetRemoteName() != "origin" || got.GetPushTarget().GetBranchName() != "main" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitUpstreamStatusChannel_NilPushTargetOmitsField(t *testing.T) {
	var got *gitgatewayv1.UpstreamStatusRequest
	fake := &fakeGitGatewayClient{
		upstreamStatusFunc: func(ctx context.Context, in *gitgatewayv1.UpstreamStatusRequest) (*gitgatewayv1.UpstreamStatusResponse, error) {
			got = in
			return &gitgatewayv1.UpstreamStatusResponse{}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.upstreamStatus",
		argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetPushTarget() != nil {
		t.Errorf("expected nil PushTarget, got %+v", got.GetPushTarget())
	}
}

func TestGitRemoteCommitUrlChannel_Success(t *testing.T) {
	var got *gitgatewayv1.RemoteCommitUrlRequest
	fake := &fakeGitGatewayClient{
		remoteCommitURLFunc: func(ctx context.Context, in *gitgatewayv1.RemoteCommitUrlRequest) (*gitgatewayv1.RemoteUrlResponse, error) {
			got = in
			return &gitgatewayv1.RemoteUrlResponse{Url: "https://github.com/org/repo/commit/abc"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.remoteCommitUrl",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "sha": "abc"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetSha() != "abc" {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.RemoteUrlResponse)
	if !ok || resp.GetUrl() != "https://github.com/org/repo/commit/abc" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestGitRemoteFileUrlChannel_Success(t *testing.T) {
	var got *gitgatewayv1.RemoteFileUrlRequest
	fake := &fakeGitGatewayClient{
		remoteFileURLFunc: func(ctx context.Context, in *gitgatewayv1.RemoteFileUrlRequest) (*gitgatewayv1.RemoteUrlResponse, error) {
			got = in
			return &gitgatewayv1.RemoteUrlResponse{Url: "https://github.com/org/repo/blob/main/a.txt"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.remoteFileUrl",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "ref": "main"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetPath() != "a.txt" || got.GetRef() != "main" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitCommitCompareChannel_SendsCommitID(t *testing.T) {
	var got *gitgatewayv1.CommitCompareRequest
	fake := &fakeGitGatewayClient{
		commitCompareFunc: func(ctx context.Context, in *gitgatewayv1.CommitCompareRequest) (*gitgatewayv1.CommitCompareResponse, error) {
			got = in
			return &gitgatewayv1.CommitCompareResponse{CommitOid: "deadbeef", Status: "ready"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.commitCompare",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "commitId": "deadbeef"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetCommitId() != "deadbeef" {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.CommitCompareResponse)
	if !ok || resp.GetCommitOid() != "deadbeef" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestGitBranchCompareChannel_SendsBaseRef(t *testing.T) {
	var got *gitgatewayv1.BranchCompareRequest
	fake := &fakeGitGatewayClient{
		branchCompareFunc: func(ctx context.Context, in *gitgatewayv1.BranchCompareRequest) (*gitgatewayv1.BranchCompareResponse, error) {
			got = in
			return &gitgatewayv1.BranchCompareResponse{Status: "ready"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.branchCompare",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "baseRef": "main"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetBaseRef() != "main" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitCommitDiffChannel_SendsRequiredFilePathAndOptionalParentOid(t *testing.T) {
	var got *gitgatewayv1.CommitDiffRequest
	fake := &fakeGitGatewayClient{
		commitDiffFunc: func(ctx context.Context, in *gitgatewayv1.CommitDiffRequest) (*gitgatewayv1.FileDiffResponse, error) {
			got = in
			return &gitgatewayv1.FileDiffResponse{Kind: "text", ModifiedContent: "new"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	parentOID := "parent1"
	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.commitDiff",
		argsJSON(t, map[string]any{
			"worktreeId": "wt-1", "commitOid": "commit1", "parentOid": parentOID, "filePath": "a.txt",
		}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetCommitOid() != "commit1" || got.GetParentOid() != "parent1" || got.GetFilePath() != "a.txt" {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.FileDiffResponse)
	if !ok || resp.GetModifiedContent() != "new" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestGitCommitDiffChannel_OmitsParentOidWhenNil(t *testing.T) {
	var got *gitgatewayv1.CommitDiffRequest
	fake := &fakeGitGatewayClient{
		commitDiffFunc: func(ctx context.Context, in *gitgatewayv1.CommitDiffRequest) (*gitgatewayv1.FileDiffResponse, error) {
			got = in
			return &gitgatewayv1.FileDiffResponse{Kind: "text"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.commitDiff",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "commitOid": "root-commit", "filePath": "a.txt"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetParentOid() != "" {
		t.Errorf("expected empty parentOid for a root commit, got %q", got.GetParentOid())
	}
}

func TestGitBranchDiffChannel_SendsBaseRefAndRequiredFilePath(t *testing.T) {
	var got *gitgatewayv1.BranchDiffRequest
	fake := &fakeGitGatewayClient{
		branchDiffFunc: func(ctx context.Context, in *gitgatewayv1.BranchDiffRequest) (*gitgatewayv1.FileDiffResponse, error) {
			got = in
			return &gitgatewayv1.FileDiffResponse{Kind: "text", ModifiedContent: "new"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.branchDiff",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "baseRef": "main", "filePath": "a.txt"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetBaseRef() != "main" || got.GetFilePath() != "a.txt" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitSubmoduleStatusChannel_SendsSubmodulePathAndArea(t *testing.T) {
	var got *gitgatewayv1.SubmoduleStatusRequest
	fake := &fakeGitGatewayClient{
		submoduleStatusFunc: func(ctx context.Context, in *gitgatewayv1.SubmoduleStatusRequest) (*gitgatewayv1.GetStatusResponse, error) {
			got = in
			return &gitgatewayv1.GetStatusResponse{Branch: "main"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.submoduleStatus",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "submodulePath": "vendor/lib", "area": "staged"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetSubmodulePath() != "vendor/lib" || got.GetArea() != "staged" {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.GetStatusResponse)
	if !ok || resp.GetBranch() != "main" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestGitFetchChannel_SendsOptionalPushTarget(t *testing.T) {
	var got *gitgatewayv1.FetchRequest
	fake := &fakeGitGatewayClient{
		fetchFunc: func(ctx context.Context, in *gitgatewayv1.FetchRequest) (*gitgatewayv1.FetchResponse, error) {
			got = in
			return &gitgatewayv1.FetchResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.fetch",
		argsJSON(t, map[string]any{
			"worktreeId": "wt-1",
			"pushTarget": map[string]any{"remoteName": "origin"},
		}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetPushTarget().GetRemoteName() != "origin" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestGitFetchChannel_NilPushTargetOmitsField(t *testing.T) {
	var got *gitgatewayv1.FetchRequest
	fake := &fakeGitGatewayClient{
		fetchFunc: func(ctx context.Context, in *gitgatewayv1.FetchRequest) (*gitgatewayv1.FetchResponse, error) {
			got = in
			return &gitgatewayv1.FetchResponse{Success: true}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.fetch",
		argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetPushTarget() != nil {
		t.Errorf("expected nil PushTarget, got %+v", got.GetPushTarget())
	}
}

func TestGitGeneratePullRequestFieldsChannel_Success(t *testing.T) {
	var got *gitgatewayv1.GeneratePullRequestFieldsRequest
	fake := &fakeGitGatewayClient{
		generatePullRequestFieldsFunc: func(ctx context.Context, in *gitgatewayv1.GeneratePullRequestFieldsRequest) (*gitgatewayv1.GeneratePullRequestFieldsResponse, error) {
			got = in
			return &gitgatewayv1.GeneratePullRequestFieldsResponse{Title: "Add widget"}, nil
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.generatePullRequestFields",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "baseBranch": "main"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetBaseBranch() != "main" {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.GeneratePullRequestFieldsResponse)
	if !ok || resp.GetTitle() != "Add widget" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestFilesReadChannel_Success(t *testing.T) {
	fake := &fakeGitGatewayClient{
		readFileFunc: func(ctx context.Context, in *gitgatewayv1.ReadFileRequest) (*gitgatewayv1.ReadFileResponse, error) {
			return &gitgatewayv1.ReadFileResponse{Content: []byte("hi"), Encoding: "utf8"}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.read",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	resp, ok := result.(*gitgatewayv1.ReadFileResponse)
	if !ok || string(resp.GetContent()) != "hi" {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestFilesWriteBase64Channel_DecodesContent(t *testing.T) {
	var got *gitgatewayv1.WriteFileRequest
	fake := &fakeGitGatewayClient{
		writeFileFunc: func(ctx context.Context, in *gitgatewayv1.WriteFileRequest) (*gitgatewayv1.WriteFileResponse, error) {
			got = in
			return &gitgatewayv1.WriteFileResponse{BytesWritten: int64(len(in.GetContent()))}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	// base64("hi") == "aGk="
	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.writeBase64",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "content": "aGk=", "base64": true}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got.GetContent()) != "hi" {
		t.Errorf("expected decoded content %q, got %q", "hi", got.GetContent())
	}
}

func TestFilesRenameChannel_KnownGapErrorPassesThrough(t *testing.T) {
	wantErr := errors.New("FAILED_PRECONDITION: rename/copy are not supported over a relay connection")
	fake := &fakeGitGatewayClient{
		renameFileFunc: func(ctx context.Context, in *gitgatewayv1.RenameFileRequest) (*gitgatewayv1.RenameFileResponse, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.rename",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "fromPath": "a.txt", "toPath": "b.txt"}))
	if err == nil {
		t.Fatal("expected the known-gap error to surface as-is, not be swallowed")
	}
}

func TestFilesCommitUploadChannel_LocalNoOpAck(t *testing.T) {
	r := NewRegistry()
	registerFilesChannels(r, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.commitUpload", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok, isMap := result.(map[string]bool); !isMap || !ok["ok"] {
		t.Errorf("expected local no-op ack {ok:true}, got %+v", result)
	}
}

func TestFilesUnwatchChannel_LocalNoOpAck(t *testing.T) {
	r := NewRegistry()
	registerFilesChannels(r, &fakeGitGatewayClient{})

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.unwatch", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok, isMap := result.(map[string]bool); !isMap || !ok["ok"] {
		t.Errorf("expected local no-op ack {ok:true}, got %+v", result)
	}
}

func TestFilesStatChannel_Success(t *testing.T) {
	var got *gitgatewayv1.StatFileRequest
	fake := &fakeGitGatewayClient{
		statFileFunc: func(ctx context.Context, in *gitgatewayv1.StatFileRequest) (*gitgatewayv1.StatFileResponse, error) {
			got = in
			return &gitgatewayv1.StatFileResponse{Exists: true, SizeBytes: 5}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.stat",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetWorktreeId() != "wt-1" || got.GetPath() != "a.txt" {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.StatFileResponse)
	if !ok || !resp.GetExists() || resp.GetSizeBytes() != 5 {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestFilesReadDirChannel_ReturnsUnwrappedEntries(t *testing.T) {
	fake := &fakeGitGatewayClient{
		readDirFunc: func(ctx context.Context, in *gitgatewayv1.ReadDirRequest) (*gitgatewayv1.ReadDirResponse, error) {
			if in.GetWorktreeId() != "wt-1" || in.GetPath() != "dir" {
				t.Errorf("unexpected request: %+v", in)
			}
			return &gitgatewayv1.ReadDirResponse{Entries: []*gitgatewayv1.DirEntry{{Name: "a.txt"}}}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.readDir",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "dir"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	entries, ok := result.([]*gitgatewayv1.DirEntry)
	if !ok || len(entries) != 1 || entries[0].GetName() != "a.txt" {
		t.Errorf("expected unwrapped entries slice, got %+v", result)
	}
}

func TestFilesReadChunkChannel_Success(t *testing.T) {
	var got *gitgatewayv1.ReadFileChunkRequest
	fake := &fakeGitGatewayClient{
		readFileChunkFunc: func(ctx context.Context, in *gitgatewayv1.ReadFileChunkRequest) (*gitgatewayv1.ReadFileChunkResponse, error) {
			got = in
			return &gitgatewayv1.ReadFileChunkResponse{Content: []byte("chunk")}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.readChunk",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "offsetBytes": 2, "lengthBytes": 3}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetOffsetBytes() != 2 || got.GetLengthBytes() != 3 {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestFilesReadChunkChannel_KnownGapErrorPassesThrough(t *testing.T) {
	wantErr := errors.New("FAILED_PRECONDITION: chunked reads are not supported over a relay connection")
	fake := &fakeGitGatewayClient{
		readFileChunkFunc: func(ctx context.Context, in *gitgatewayv1.ReadFileChunkRequest) (*gitgatewayv1.ReadFileChunkResponse, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.readChunk",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt"}))
	if err == nil {
		t.Fatal("expected the known-gap error to surface as-is, not be swallowed")
	}
}

func TestFilesReadPreviewChannel_Success(t *testing.T) {
	var got *gitgatewayv1.ReadFilePreviewRequest
	fake := &fakeGitGatewayClient{
		readFilePreviewFunc: func(ctx context.Context, in *gitgatewayv1.ReadFilePreviewRequest) (*gitgatewayv1.ReadFilePreviewResponse, error) {
			got = in
			return &gitgatewayv1.ReadFilePreviewResponse{Content: []byte("preview"), Truncated: true}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.readPreview",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "maxBytes": 100}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetMaxBytes() != 100 {
		t.Errorf("unexpected request: %+v", got)
	}
	resp, ok := result.(*gitgatewayv1.ReadFilePreviewResponse)
	if !ok || !resp.GetTruncated() {
		t.Errorf("unexpected result: %+v", result)
	}
}

func TestFilesWriteChannels_BothResolveToWriteFileRPC(t *testing.T) {
	var calls []*gitgatewayv1.WriteFileRequest
	fake := &fakeGitGatewayClient{
		writeFileFunc: func(ctx context.Context, in *gitgatewayv1.WriteFileRequest) (*gitgatewayv1.WriteFileResponse, error) {
			calls = append(calls, in)
			return &gitgatewayv1.WriteFileResponse{BytesWritten: int64(len(in.GetContent()))}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.write",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "content": "hi", "base64": false})); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.writeBase64",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "b.bin", "content": "aGk=", "base64": true})); err != nil {
		t.Fatal(err)
	}

	if len(calls) != 2 {
		t.Fatalf("expected both channels to call WriteFile, got %d calls", len(calls))
	}
	if string(calls[0].GetContent()) != "hi" {
		t.Errorf("files.write: expected raw content passthrough, got %q", calls[0].GetContent())
	}
	if string(calls[1].GetContent()) != "hi" {
		t.Errorf("files.writeBase64: expected decoded content %q, got %q", "hi", calls[1].GetContent())
	}
}

func TestFilesWriteBase64Channel_InvalidBase64_NoRPCCall(t *testing.T) {
	called := false
	fake := &fakeGitGatewayClient{
		writeFileFunc: func(ctx context.Context, in *gitgatewayv1.WriteFileRequest) (*gitgatewayv1.WriteFileResponse, error) {
			called = true
			return &gitgatewayv1.WriteFileResponse{}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.writeBase64",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.bin", "content": "not-valid-base64!!", "base64": true}))
	if err == nil {
		t.Fatal("expected a decode error")
	}
	if called {
		t.Error("expected zero WriteFile calls on decode failure")
	}
}

func TestFilesWriteBase64ChunkChannel_DecodesContent(t *testing.T) {
	var got *gitgatewayv1.WriteFileChunkRequest
	fake := &fakeGitGatewayClient{
		writeFileChunkFunc: func(ctx context.Context, in *gitgatewayv1.WriteFileChunkRequest) (*gitgatewayv1.WriteFileChunkResponse, error) {
			got = in
			return &gitgatewayv1.WriteFileChunkResponse{BytesWritten: int64(len(in.GetContent()))}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.writeBase64Chunk",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "offsetBytes": 0, "content": "aGk=", "isFinal": true}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got.GetContent()) != "hi" || !got.GetIsFinal() {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestFilesCreateDirChannels_BothResolveToCreateDirRPC(t *testing.T) {
	var calls []*gitgatewayv1.CreateDirRequest
	fake := &fakeGitGatewayClient{
		createDirFunc: func(ctx context.Context, in *gitgatewayv1.CreateDirRequest) (*gitgatewayv1.CreateDirResponse, error) {
			calls = append(calls, in)
			return &gitgatewayv1.CreateDirResponse{}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.createDir",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "dir1", "recursive": true})); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.createDirNoClobber",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "dir2", "noClobber": true})); err != nil {
		t.Fatal(err)
	}

	if len(calls) != 2 {
		t.Fatalf("expected both channels to call CreateDir, got %d calls", len(calls))
	}
	if calls[0].GetNoClobber() {
		t.Error("files.createDir: expected noClobber=false")
	}
	if !calls[1].GetNoClobber() {
		t.Error("files.createDirNoClobber: expected noClobber=true")
	}
}

func TestFilesCreateFileChannel_Success(t *testing.T) {
	var got *gitgatewayv1.CreateFileRequest
	fake := &fakeGitGatewayClient{
		createFileFunc: func(ctx context.Context, in *gitgatewayv1.CreateFileRequest) (*gitgatewayv1.CreateFileResponse, error) {
			got = in
			return &gitgatewayv1.CreateFileResponse{}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	if _, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.createFile",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "new.txt"})); err != nil {
		t.Fatal(err)
	}
	if got.GetWorktreeId() != "wt-1" || got.GetPath() != "new.txt" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestFilesCreateFileChannel_ErrorPassesThrough(t *testing.T) {
	wantErr := errors.New("already exists")
	fake := &fakeGitGatewayClient{
		createFileFunc: func(ctx context.Context, in *gitgatewayv1.CreateFileRequest) (*gitgatewayv1.CreateFileResponse, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.createFile",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "new.txt"}))
	if !errors.Is(err, wantErr) {
		t.Fatalf("expected error to pass through, got %v", err)
	}
}

func TestFilesDeleteChannel_Success(t *testing.T) {
	var got *gitgatewayv1.DeleteFileRequest
	fake := &fakeGitGatewayClient{
		deleteFileFunc: func(ctx context.Context, in *gitgatewayv1.DeleteFileRequest) (*emptypb.Empty, error) {
			got = in
			return &emptypb.Empty{}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.delete",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "path": "a.txt", "recursive": true}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.GetRecursive() {
		t.Errorf("unexpected request: %+v", got)
	}
	if ok, isMap := result.(map[string]bool); !isMap || !ok["ok"] {
		t.Errorf("expected {ok:true} ack, got %+v", result)
	}
}

func TestFilesSearchChannel_ReturnsUnwrappedMatches(t *testing.T) {
	fake := &fakeGitGatewayClient{
		searchFilesFunc: func(ctx context.Context, in *gitgatewayv1.SearchFilesRequest) (*gitgatewayv1.SearchFilesResponse, error) {
			if in.GetPattern() != "TODO" || !in.GetIsRegex() {
				t.Errorf("unexpected request: %+v", in)
			}
			return &gitgatewayv1.SearchFilesResponse{Matches: []*gitgatewayv1.SearchMatch{{Path: "a.go", Line: 1}}}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.search",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "pattern": "TODO", "isRegex": true, "maxResults": 10}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	matches, ok := result.([]*gitgatewayv1.SearchMatch)
	if !ok || len(matches) != 1 || matches[0].GetPath() != "a.go" {
		t.Errorf("expected unwrapped matches slice, got %+v", result)
	}
}

func TestFilesListAllChannel_ReturnsUnwrappedPaths(t *testing.T) {
	fake := &fakeGitGatewayClient{
		listAllFilesFunc: func(ctx context.Context, in *gitgatewayv1.ListAllFilesRequest) (*gitgatewayv1.ListAllFilesResponse, error) {
			return &gitgatewayv1.ListAllFilesResponse{Paths: []string{"a.txt", "b.go"}}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.listAll",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "pathGlob": "*"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	paths, ok := result.([]string)
	if !ok || len(paths) != 2 {
		t.Errorf("expected unwrapped paths slice, got %+v", result)
	}
}

func TestFilesListMarkdownDocumentsChannel_ReturnsUnwrappedPaths(t *testing.T) {
	fake := &fakeGitGatewayClient{
		listMarkdownDocumentsFunc: func(ctx context.Context, in *gitgatewayv1.ListMarkdownDocumentsRequest) (*gitgatewayv1.ListMarkdownDocumentsResponse, error) {
			return &gitgatewayv1.ListMarkdownDocumentsResponse{Paths: []string{"README.md"}}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	result, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.listMarkdownDocuments",
		argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	paths, ok := result.([]string)
	if !ok || len(paths) != 1 || paths[0] != "README.md" {
		t.Errorf("expected unwrapped paths slice, got %+v", result)
	}
}

func TestFilesCopyChannel_Success(t *testing.T) {
	var got *gitgatewayv1.CopyFileRequest
	fake := &fakeGitGatewayClient{
		copyFileFunc: func(ctx context.Context, in *gitgatewayv1.CopyFileRequest) (*gitgatewayv1.CopyFileResponse, error) {
			got = in
			return &gitgatewayv1.CopyFileResponse{}, nil
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.copy",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "fromPath": "a.txt", "toPath": "b.txt"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.GetFromPath() != "a.txt" || got.GetToPath() != "b.txt" {
		t.Errorf("unexpected request: %+v", got)
	}
}

func TestFilesCopyChannel_KnownGapErrorPassesThrough(t *testing.T) {
	wantErr := errors.New("FAILED_PRECONDITION: rename/copy are not supported over a relay connection")
	fake := &fakeGitGatewayClient{
		copyFileFunc: func(ctx context.Context, in *gitgatewayv1.CopyFileRequest) (*gitgatewayv1.CopyFileResponse, error) {
			return nil, wantErr
		},
	}
	r := NewRegistry()
	registerFilesChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "files.copy",
		argsJSON(t, map[string]any{"worktreeId": "wt-1", "fromPath": "a.txt", "toPath": "b.txt"}))
	if err == nil {
		t.Fatal("expected the known-gap error to surface as-is, not be swallowed")
	}
}

// TestGitStatusChannel_DecodesWorktreeSelector locks in the fix for a live
// bug: every real caller (WorkspaceContext.tsx, useGit.ts, use-code-review.ts,
// runtime-git-client.ts, web-preload-api.ts's status) sends the worktree
// selector under "worktree" (toRuntimeWorktreeSelector, "id:"-prefixed) —
// never "worktreeId". The old handler decoded "worktreeId", so WorktreeId
// was always empty and every real call tripped git-gateway-service's
// GITGATEWAY_MISSING_WORKTREE_ID guard (confirmed live, repeating in
// git-gateway-service's logs).
func TestGitStatusChannel_DecodesWorktreeSelector(t *testing.T) {
	var gotReq *gitgatewayv1.GetStatusRequest
	fake := &fakeGitGatewayClient{
		getStatusFunc: func(_ context.Context, in *gitgatewayv1.GetStatusRequest) (*gitgatewayv1.GetStatusResponse, error) {
			gotReq = in
			return &gitgatewayv1.GetStatusResponse{}, nil
		},
	}
	r := NewRegistry()
	registerGitChannels(r, fake)

	_, err := r.Dispatch(context.Background(), Identity{TenantID: "t1"}, "git.status",
		argsJSON(t, map[string]any{"worktree": "id:wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if gotReq.GetWorktreeId() != "wt-1" {
		t.Errorf("WorktreeId = %q, want %q (expected the id: prefix stripped)", gotReq.GetWorktreeId(), "wt-1")
	}
}

// ── TASK-032: git.cancelGenerateCommitMessage / cancelGeneratePullRequestFields ──

func TestGitCancelGenerateCommitMessage_CancelsInFlightCall(t *testing.T) {
	started := make(chan struct{})
	fake := &fakeGitGatewayClient{
		generateCommitMessageFunc: func(ctx context.Context, in *gitgatewayv1.GenerateCommitMessageRequest) (*gitgatewayv1.GenerateCommitMessageResponse, error) {
			close(started)
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	errCh := make(chan error, 1)
	go func() {
		_, err := r.Dispatch(context.Background(), Identity{}, "git.generateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
		errCh <- err
	}()
	<-started

	_, err := r.Dispatch(context.Background(), Identity{}, "git.cancelGenerateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("unexpected error from cancel: %v", err)
	}

	if genErr := <-errCh; genErr == nil {
		t.Fatal("want the in-flight generate call to fail once cancelled")
	}

	// A second cancel for the same, now-finished worktree must be a clean no-op.
	_, err = r.Dispatch(context.Background(), Identity{}, "git.cancelGenerateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	if err != nil {
		t.Fatalf("second cancel: unexpected error: %v", err)
	}
}

func TestGitCancelGenerateCommitMessage_NoInFlightCallIsCleanNoOp(t *testing.T) {
	r := NewRegistry()
	registerGitDeepChannels(r, &fakeGitGatewayClient{})

	_, err := r.Dispatch(context.Background(), Identity{}, "git.cancelGenerateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "no-such-worktree"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGitCancelGeneratePullRequestFields_DoesNotCancelCommitMessage(t *testing.T) {
	commitStarted := make(chan struct{})
	commitCtx := make(chan context.Context, 1)
	fake := &fakeGitGatewayClient{
		generateCommitMessageFunc: func(ctx context.Context, in *gitgatewayv1.GenerateCommitMessageRequest) (*gitgatewayv1.GenerateCommitMessageResponse, error) {
			commitCtx <- ctx
			close(commitStarted)
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	r := NewRegistry()
	registerGitDeepChannels(r, fake)

	go r.Dispatch(context.Background(), Identity{}, "git.generateCommitMessage", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))
	<-commitStarted

	// Cancelling pullRequestFields for the SAME worktree must not touch the
	// independent commitMessage in-flight call.
	_, _ = r.Dispatch(context.Background(), Identity{}, "git.cancelGeneratePullRequestFields", argsJSON(t, map[string]any{"worktreeId": "wt-1"}))

	select {
	case ctx := <-commitCtx:
		if ctx.Err() != nil {
			t.Fatal("want commitMessage's context still live — pullRequestFields cancel must not affect it")
		}
	default:
		t.Fatal("expected to have captured the in-flight commitMessage context")
	}
}
