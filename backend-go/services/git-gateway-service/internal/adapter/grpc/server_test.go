package grpc

import (
	"context"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/usecase"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
)

// fakeResolver/fakeExecutor let this test exercise wire<->usecase
// translation without touching a real ConnectionResolver/GitExecutor
// implementation. fakeExecutor implements usecase.GitExecutor,
// usecase.FilesystemExecutor, and usecase.LocalOnlyFilesystemExecutor —
// this service's fake-adapter test convention uses one type across all
// three ports since they're all selected by the same dispatch shape.
type fakeResolver struct{ conn usecase.ResolvedConnection }

func (f *fakeResolver) ResolveConnection(context.Context, string) (usecase.ResolvedConnection, error) {
	return f.conn, nil
}

type fakeExecutor struct{}

func (fakeExecutor) GetStatus(context.Context, string) (domain.GitStatus, error) {
	return domain.GitStatus{
		Branch: "main",
		Files:  []domain.FileStatus{{Path: "a.txt", State: domain.FileStateModified}},
	}, nil
}

func (fakeExecutor) GetDiff(context.Context, string, string, bool) (domain.DiffResult, error) {
	return domain.DiffResult{UnifiedDiff: "diff --git a/a.txt b/a.txt"}, nil
}

func (fakeExecutor) Commit(context.Context, string, string, []string) (domain.CommitResult, error) {
	return domain.CommitResult{CommitSHA: "deadbeef"}, nil
}

func (fakeExecutor) Push(context.Context, string, string, string) (domain.PushResult, error) {
	return domain.PushResult{Success: true}, nil
}

func (fakeExecutor) Pull(context.Context, string) (domain.PullResult, error) {
	return domain.PullResult{Success: true, HadConflicts: false}, nil
}

func (fakeExecutor) Stage(context.Context, string, []string) (domain.SimpleResult, error) {
	return domain.SimpleResult{Success: true}, nil
}

func (fakeExecutor) Unstage(context.Context, string, []string) (domain.SimpleResult, error) {
	return domain.SimpleResult{Success: true}, nil
}

func (fakeExecutor) History(context.Context, string, string, int) ([]domain.CommitRef, error) {
	return []domain.CommitRef{{SHA: "deadbeef", Message: "fix"}}, nil
}

func (fakeExecutor) CheckIgnored(context.Context, string, []string) ([]string, error) {
	return []string{"node_modules"}, nil
}

func (fakeExecutor) ForkSync(context.Context, string, string) (domain.ForkSyncStatus, error) {
	return domain.ForkSyncStatus{Ahead: 1, Behind: 2}, nil
}

func (fakeExecutor) UpstreamStatus(context.Context, string, *domain.PushTargetInput) (domain.UpstreamStatus, error) {
	return domain.UpstreamStatus{HasUpstream: true, Ahead: 1}, nil
}

func (fakeExecutor) RemoteCommitURL(context.Context, string, string) (string, error) {
	return "https://example.com/commit/deadbeef", nil
}

func (fakeExecutor) RemoteFileURL(context.Context, string, string, string) (string, error) {
	return "https://example.com/blob/main/a.txt", nil
}

func (fakeExecutor) RemoteURL(context.Context, string, string) (string, error) {
	return "git@github.com:example/repo.git", nil
}

func (fakeExecutor) Fetch(context.Context, string, *domain.PushTargetInput) (domain.SimpleResult, error) {
	return domain.SimpleResult{Success: true}, nil
}

func (fakeExecutor) CommitCompare(context.Context, string, string) (domain.CommitCompareResult, error) {
	return domain.CommitCompareResult{
		CommitOID: "deadbeef", CompareRef: "deadbee", BaseRef: "empty tree", Status: "ready",
		ChangedFiles: 1, Entries: []domain.GitChangeEntry{{Path: "a.txt", Status: "modified", Added: 1}},
	}, nil
}

func (fakeExecutor) BranchCompare(context.Context, string, string) (domain.BranchCompareResult, error) {
	return domain.BranchCompareResult{
		BaseRef: "main", BaseOID: "base123", CompareRef: "feature", HeadOID: "head456",
		MergeBase: "merge789", ChangedFiles: 1, CommitsAhead: 2, Status: "ready",
		Entries: []domain.GitChangeEntry{{Path: "a.txt", Status: "modified", Added: 1}},
	}, nil
}

func (fakeExecutor) CommitDiff(context.Context, string, string, string, string, string) (domain.FileDiffResult, error) {
	return domain.FileDiffResult{Kind: "text", OriginalContent: "old", ModifiedContent: "new"}, nil
}

func (fakeExecutor) BranchDiff(context.Context, string, string, string, string) (domain.FileDiffResult, error) {
	return domain.FileDiffResult{Kind: "text", OriginalContent: "old", ModifiedContent: "new"}, nil
}

func (fakeExecutor) SubmoduleStatus(context.Context, string, string, string) (domain.GitStatus, error) {
	return domain.GitStatus{
		Branch: "main", Files: []domain.FileStatus{{Path: "sub.txt", State: domain.FileStateModified}},
	}, nil
}

func (fakeExecutor) ReadFile(context.Context, string, string) ([]byte, error) {
	return []byte("content"), nil
}

func (fakeExecutor) ReadFilePreview(context.Context, string, string, int64) ([]byte, bool, error) {
	return []byte("preview"), false, nil
}

func (fakeExecutor) ReadDir(context.Context, string, string) ([]domain.DirEntry, error) {
	return []domain.DirEntry{{Name: "a.txt"}}, nil
}

func (fakeExecutor) WriteFile(context.Context, string, string, []byte, bool) (int64, error) {
	return 7, nil
}

func (fakeExecutor) WriteFileChunk(context.Context, string, string, int64, []byte, bool) (int64, error) {
	return 4, nil
}

func (fakeExecutor) CreateDir(context.Context, string, string, bool, bool) error { return nil }

func (fakeExecutor) CreateFile(context.Context, string, string) error   { return nil }
func (fakeExecutor) Delete(context.Context, string, string, bool) error { return nil }

func (fakeExecutor) Stat(context.Context, string, string) (domain.FileStat, error) {
	return domain.FileStat{Exists: true, SizeBytes: 7}, nil
}

func (fakeExecutor) Search(context.Context, string, domain.SearchOptions) ([]domain.SearchMatch, error) {
	return []domain.SearchMatch{{Path: "a.txt", Line: 1, LineText: "match"}}, nil
}

func (fakeExecutor) Glob(context.Context, string, string, int) ([]string, error) {
	return []string{"a.txt", "b.md"}, nil
}

func (fakeExecutor) Rename(context.Context, string, string, string) error { return nil }
func (fakeExecutor) Copy(context.Context, string, string, string) error   { return nil }

func (fakeExecutor) Clone(context.Context, string, string) (string, string, error) {
	return "/repo/cloned", "main", nil
}

func (fakeExecutor) InitRepo(context.Context, string, string, string, string) (string, string, bool, error) {
	return "/repo/init", "main", false, nil
}

func (fakeExecutor) BaseRefDefault(context.Context, string) (string, error) {
	return "main", nil
}

func (fakeExecutor) SearchRefs(context.Context, string, string) ([]string, error) {
	return []string{"main", "feature/x"}, nil
}

func (fakeExecutor) CheckHooks(context.Context, string) ([]string, bool, error) {
	return []string{"pre-commit", "post-checkout"}, true, nil
}

func (fakeExecutor) ReadIssueCommand(context.Context, string) (string, bool, error) {
	return `{"command":"gh issue view"}`, true, nil
}

func (fakeExecutor) WriteIssueCommand(context.Context, string, string) error {
	return nil
}

func (fakeExecutor) ScanSetupScriptImports(context.Context, string) ([]string, error) {
	return []string{"source ./lib.sh"}, nil
}

// fakeReachability is a usecase.DevServerReachability stub for exercising
// Clone/InitRepo's wire<->usecase translation.
type fakeReachability struct{ reachable bool }

func (f fakeReachability) IsReachable(context.Context, string) (bool, error) {
	return f.reachable, nil
}

func (fakeExecutor) CreateWorktree(context.Context, string, string, string) (domain.WorktreeCreateResult, error) {
	return domain.WorktreeCreateResult{Path: "/repo-branch", HeadSHA: "deadbeef"}, nil
}

func (fakeExecutor) RemoveWorktree(context.Context, string, bool) error {
	return nil
}

func (fakeExecutor) FetchAndResolveRef(context.Context, string, string) (string, error) {
	return "resolvedsha", nil
}

func (fakeExecutor) ListWorktreePaths(context.Context, string) ([]domain.WorktreeGitInfo, error) {
	return []domain.WorktreeGitInfo{{Path: "/repo"}, {Path: "/repo-branch"}}, nil
}

func (fakeExecutor) ForceDeleteBranch(context.Context, string, string) error {
	return nil
}

// ── Group A — branch/ref operations (TASK-207) ─────────────────────────────

func (fakeExecutor) Checkout(context.Context, string, string) (domain.CheckoutResult, error) {
	return domain.CheckoutResult{Success: true, Branch: "main"}, nil
}

func (fakeExecutor) ListLocalBranches(context.Context, string) ([]domain.BranchInfo, error) {
	return []domain.BranchInfo{{Name: "main", IsCurrent: true}}, nil
}

func (fakeExecutor) FastForward(context.Context, string, *domain.PushTargetInput) (domain.FastForwardResult, error) {
	return domain.FastForwardResult{Success: true}, nil
}

func (fakeExecutor) RebaseFromBase(context.Context, string, string) (domain.RebaseResult, error) {
	return domain.RebaseResult{Success: true}, nil
}

func (fakeExecutor) AbortRebase(context.Context, string) (domain.SimpleResult, error) {
	return domain.SimpleResult{Success: true}, nil
}

func (fakeExecutor) AbortMerge(context.Context, string) (domain.SimpleResult, error) {
	return domain.SimpleResult{Success: true}, nil
}

func (fakeExecutor) ConflictOperation(context.Context, string) (string, error) {
	return "unknown", nil
}

func (fakeExecutor) ResolveConflict(context.Context, string, string, string) (domain.SimpleResult, error) {
	return domain.SimpleResult{Success: true}, nil
}

func (fakeExecutor) Discard(context.Context, string, string) (domain.SimpleResult, error) {
	return domain.SimpleResult{Success: true}, nil
}

func (fakeExecutor) BulkDiscard(context.Context, string, []string) (domain.BulkDiscardResult, error) {
	return domain.BulkDiscardResult{Success: true}, nil
}

// fakeProjectClient/fakeSCMClient are minimal stubs for exercising the
// worktree usecases' wire<->usecase translation — none of this file's
// tests exercise the saga/compensation logic itself (that's
// internal/usecase's own test suite); these just need to satisfy the New(...)
// constructor's signature with something that succeeds.
type fakeProjectClient struct{}

func (fakeProjectClient) GetRepo(_ context.Context, repoID string) (domain.RepoInfo, error) {
	return domain.RepoInfo{ID: repoID}, nil
}

func (fakeProjectClient) RecordWorktreeCreated(_ context.Context, _, _, path, branch string, _ domain.WorktreeLineageCapture) (domain.WorktreeRecord, error) {
	return domain.WorktreeRecord{ID: "wt-1", Path: path, Branch: branch}, nil
}

func (fakeProjectClient) RecordWorktreeRemoved(context.Context, string) error {
	return nil
}

type fakeSCMClient struct{}

func (fakeSCMClient) GetPullRequestBase(context.Context, string, int32) (string, string, error) {
	return "main", "basesha", nil
}

func (fakeSCMClient) GetMergeRequestBase(context.Context, string, int32) (string, string, error) {
	return "main", "basesha", nil
}

// fakeAICompleter is a usecase.AICompleter stub for exercising
// GenerateCommitMessage's wire<->usecase translation.
type fakeAICompleter struct{ message string }

func (f fakeAICompleter) Complete(context.Context, string, string) (string, error) {
	return f.message, nil
}

// fakeAIProviderResolver is a usecase.AIProviderResolver stub for
// exercising DiscoverCommitMessageModels' wire<->usecase translation.
type fakeAIProviderResolver struct{}

func (fakeAIProviderResolver) ResolveProvider(context.Context, string, string) (string, string, string, error) {
	return "PROVIDER_TYPE_ANTHROPIC", "acct-1", "active", nil
}

func newTestServerWithResolver(resolver *fakeResolver) *Server {
	exec := fakeExecutor{}
	getStatusUC := usecase.NewGetStatus(resolver, exec, exec)
	reachability := fakeReachability{reachable: false}
	projects := fakeProjectClient{}
	scm := fakeSCMClient{}
	getDiffUC := usecase.NewGetDiff(resolver, exec, exec)
	completer := fakeAICompleter{message: "generated message"}
	return New(
		getStatusUC,
		getDiffUC,
		usecase.NewCommit(resolver, exec, exec),
		usecase.NewPush(resolver, exec, exec),
		usecase.NewPull(resolver, exec, exec),
		usecase.NewGenerateCommitMessage(resolver, getStatusUC, getDiffUC, completer),
		usecase.NewStage(resolver, exec, exec),
		usecase.NewUnstage(resolver, exec, exec),
		usecase.NewHistory(resolver, exec, exec),
		usecase.NewCheckIgnored(resolver, exec, exec),
		usecase.NewForkSync(resolver, exec, exec),
		usecase.NewUpstreamStatus(resolver, exec, exec),
		usecase.NewCommitCompare(resolver, exec, exec),
		usecase.NewBranchCompare(resolver, exec, exec),
		usecase.NewCommitDiff(resolver, exec, exec),
		usecase.NewBranchDiff(resolver, exec, exec),
		usecase.NewSubmoduleStatus(resolver, exec, exec),
		usecase.NewRemoteCommitURL(resolver, exec, exec),
		usecase.NewRemoteFileURL(resolver, exec, exec),
		usecase.NewGetRemoteURL(reachability, projects, exec, exec),
		usecase.NewFetch(resolver, exec, exec),
		usecase.NewGeneratePullRequestFields(resolver, getStatusUC, getDiffUC, completer),
		usecase.NewDiscoverCommitMessageModels(fakeAIProviderResolver{}),
		usecase.NewReadFileUseCase(resolver, exec, exec),
		usecase.NewReadFileChunkUseCase(resolver, exec),
		usecase.NewReadFilePreviewUseCase(resolver, exec, exec),
		usecase.NewReadDirUseCase(resolver, exec, exec),
		usecase.NewWriteFileUseCase(resolver, exec, exec),
		usecase.NewWriteFileChunkUseCase(resolver, exec, exec),
		usecase.NewCreateDirUseCase(resolver, exec, exec),
		usecase.NewCreateFileUseCase(resolver, exec, exec),
		usecase.NewDeleteFileUseCase(resolver, exec, exec),
		usecase.NewStatFileUseCase(resolver, exec, exec),
		usecase.NewSearchFilesUseCase(resolver, exec, exec),
		usecase.NewListAllFilesUseCase(resolver, exec, exec),
		usecase.NewListMarkdownDocumentsUseCase(resolver, exec, exec),
		usecase.NewRenameFileUseCase(resolver, exec),
		usecase.NewCopyFileUseCase(resolver, exec),
		usecase.NewClone(reachability, exec, exec),
		usecase.NewInitRepo(reachability, exec, exec),
		usecase.NewBaseRefDefault(reachability, projects, exec, exec),
		usecase.NewSearchRefs(reachability, projects, exec, exec),
		usecase.NewCheckHooks(reachability, projects, exec, exec),
		usecase.NewReadIssueCommand(reachability, projects, exec, exec),
		usecase.NewWriteIssueCommand(reachability, projects, exec, exec),
		usecase.NewScanSetupScriptImports(reachability, projects, exec, exec),
		usecase.NewCreateWorktree(reachability, projects, exec, exec),
		usecase.NewRemoveWorktree(resolver, projects, exec, exec),
		usecase.NewForceDeleteBranch(resolver, exec, exec),
		usecase.NewDetectWorktrees(reachability, projects, exec, exec),
		usecase.NewPrefetchCreateBase(reachability, projects, exec, exec),
		usecase.NewResolvePrBase(scm, reachability, projects, exec, exec),
		usecase.NewResolveMrBase(scm, reachability, projects, exec, exec),
		usecase.NewCheckout(resolver, exec, exec),
		usecase.NewListLocalBranches(resolver, exec, exec),
		usecase.NewFastForward(resolver, exec, exec),
		usecase.NewRebaseFromBase(resolver, exec, exec),
		usecase.NewAbortRebase(resolver, exec, exec),
		usecase.NewAbortMerge(resolver, exec, exec),
		usecase.NewConflictOperation(resolver, exec, exec),
		usecase.NewResolveConflict(resolver, exec, exec),
		usecase.NewDiscard(resolver, exec, exec),
		usecase.NewBulkDiscard(resolver, exec, exec),
		usecase.NewReadEphemeralVmRecipes(reachability, projects, exec, exec),
		// nil FileWatchStreamer: this test only exercises server construction
		// wiring, not WatchWorktree's own behavior (no dedicated test needs
		// one yet — BACKLOG-003).
		usecase.NewWatchWorktreeFiles(resolver, nil),
	)
}

func newTestServer() *Server {
	return newTestServerWithResolver(&fakeResolver{conn: usecase.ResolvedConnection{Connected: false, RepoPath: "/repo"}})
}

func TestServer_GetStatus_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.GetStatus(context.Background(), &gitgatewayv1.GetStatusRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetBranch() != "main" {
		t.Errorf("expected branch=main, got %q", resp.GetBranch())
	}
	if len(resp.GetFiles()) != 1 || resp.GetFiles()[0].GetState() != "modified" {
		t.Errorf("unexpected files: %+v", resp.GetFiles())
	}
}

func TestServer_GetStatus_MissingWorktreeID_ReturnsInvalidArgument(t *testing.T) {
	s := newTestServer()
	_, err := s.GetStatus(context.Background(), &gitgatewayv1.GetStatusRequest{})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestServer_GetDiff_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.GetDiff(context.Background(), &gitgatewayv1.GetDiffRequest{WorktreeId: "wt-1", FilePath: "a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetUnifiedDiff() == "" {
		t.Error("expected non-empty unified diff")
	}
}

func TestServer_Commit_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.Commit(context.Background(), &gitgatewayv1.CommitRequest{WorktreeId: "wt-1", Message: "fix"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetCommitSha() != "deadbeef" {
		t.Errorf("expected commit_sha=deadbeef, got %q", resp.GetCommitSha())
	}
}

func TestServer_Pull_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.Pull(context.Background(), &gitgatewayv1.PullRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() || resp.GetHadConflicts() {
		t.Errorf("unexpected pull response: %+v", resp)
	}
}

func TestServer_GenerateCommitMessage_NotConnected_ReturnsFailedPrecondition(t *testing.T) {
	// newTestServer's resolver reports Connected=false, i.e. no dev server
	// for this worktree — GenerateCommitMessage has no AI-relay path in
	// that case (see usecase.GenerateCommitMessage's doc comment).
	s := newTestServer()
	_, err := s.GenerateCommitMessage(context.Background(), &gitgatewayv1.GenerateCommitMessageRequest{WorktreeId: "wt-1"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestServer_GenerateCommitMessage_Connected_TranslatesResult(t *testing.T) {
	s := newTestServerWithResolver(&fakeResolver{conn: usecase.ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo"}})

	resp, err := s.GenerateCommitMessage(context.Background(), &gitgatewayv1.GenerateCommitMessageRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetMessage() != "generated message" {
		t.Errorf("expected message=%q, got %q", "generated message", resp.GetMessage())
	}
}

func TestServer_Stage_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.Stage(context.Background(), &gitgatewayv1.StageRequest{WorktreeId: "wt-1", Paths: []string{"a.txt"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Error("expected success=true")
	}
}

func TestServer_Unstage_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.Unstage(context.Background(), &gitgatewayv1.UnstageRequest{WorktreeId: "wt-1", Paths: []string{"a.txt"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Error("expected success=true")
	}
}

func TestServer_History_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.History(context.Background(), &gitgatewayv1.HistoryRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetCommits()) != 1 || resp.GetCommits()[0].GetSha() != "deadbeef" {
		t.Errorf("unexpected commits: %+v", resp.GetCommits())
	}
}

func TestServer_CheckIgnored_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.CheckIgnored(context.Background(), &gitgatewayv1.CheckIgnoredRequest{WorktreeId: "wt-1", Paths: []string{"node_modules"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetIgnoredPaths()) != 1 || resp.GetIgnoredPaths()[0] != "node_modules" {
		t.Errorf("unexpected ignored paths: %+v", resp.GetIgnoredPaths())
	}
}

func TestServer_ForkSync_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.ForkSync(context.Background(), &gitgatewayv1.ForkSyncRequest{WorktreeId: "wt-1", ExpectedUpstream: "origin/main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetAhead() != 1 || resp.GetBehind() != 2 {
		t.Errorf("unexpected fork sync response: %+v", resp)
	}
}

func TestServer_UpstreamStatus_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.UpstreamStatus(context.Background(), &gitgatewayv1.UpstreamStatusRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetHasUpstream() {
		t.Error("expected has_upstream=true")
	}
}

func TestServer_RemoteCommitUrl_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.RemoteCommitUrl(context.Background(), &gitgatewayv1.RemoteCommitUrlRequest{WorktreeId: "wt-1", Sha: "deadbeef"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetUrl() == "" {
		t.Error("expected non-empty url")
	}
}

func TestServer_RemoteFileUrl_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.RemoteFileUrl(context.Background(), &gitgatewayv1.RemoteFileUrlRequest{WorktreeId: "wt-1", Path: "a.txt", Ref: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetUrl() == "" {
		t.Error("expected non-empty url")
	}
}

func TestServer_GeneratePullRequestFields_NotConnected_ReturnsFailedPrecondition(t *testing.T) {
	s := newTestServer()
	_, err := s.GeneratePullRequestFields(context.Background(), &gitgatewayv1.GeneratePullRequestFieldsRequest{WorktreeId: "wt-1"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestServer_GeneratePullRequestFields_Connected_TranslatesResult(t *testing.T) {
	s := newTestServerWithResolver(&fakeResolver{conn: usecase.ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo"}})
	resp, err := s.GeneratePullRequestFields(context.Background(), &gitgatewayv1.GeneratePullRequestFieldsRequest{WorktreeId: "wt-1", BaseBranch: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetTitle() == "" {
		t.Error("expected non-empty title")
	}
}

func TestServer_DiscoverCommitMessageModels_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.DiscoverCommitMessageModels(context.Background(), &gitgatewayv1.DiscoverCommitMessageModelsRequest{TenantId: "t-1", UserId: "u-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetModels()) != 1 || resp.GetModels()[0].GetAccountId() != "acct-1" {
		t.Errorf("unexpected models: %+v", resp.GetModels())
	}
}

func TestServer_ReadFile_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.ReadFile(context.Background(), &gitgatewayv1.ReadFileRequest{WorktreeId: "wt-1", Path: "a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(resp.GetContent()) != "content" {
		t.Errorf("unexpected content: %q", resp.GetContent())
	}
}

func TestServer_WriteFile_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.WriteFile(context.Background(), &gitgatewayv1.WriteFileRequest{WorktreeId: "wt-1", Path: "a.txt", Content: []byte("x")})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetBytesWritten() != 7 {
		t.Errorf("unexpected bytes written: %d", resp.GetBytesWritten())
	}
}

func TestServer_CreateFile_Success(t *testing.T) {
	s := newTestServer()
	resp, err := s.CreateFile(context.Background(), &gitgatewayv1.CreateFileRequest{WorktreeId: "wt-1", Path: "new.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp == nil {
		t.Fatal("expected non-nil response")
	}
}

func TestServer_StatFile_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.StatFile(context.Background(), &gitgatewayv1.StatFileRequest{WorktreeId: "wt-1", Path: "a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetExists() || resp.GetSizeBytes() != 7 {
		t.Errorf("unexpected stat response: %+v", resp)
	}
}

func TestServer_SearchFiles_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.SearchFiles(context.Background(), &gitgatewayv1.SearchFilesRequest{WorktreeId: "wt-1", Pattern: "match"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetMatches()) != 1 {
		t.Errorf("unexpected matches: %+v", resp.GetMatches())
	}
}

func TestServer_ListAllFiles_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.ListAllFiles(context.Background(), &gitgatewayv1.ListAllFilesRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetPaths()) != 2 {
		t.Errorf("unexpected paths: %+v", resp.GetPaths())
	}
}

func TestServer_ListMarkdownDocuments_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.ListMarkdownDocuments(context.Background(), &gitgatewayv1.ListMarkdownDocumentsRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetPaths()) != 1 || resp.GetPaths()[0] != "b.md" {
		t.Errorf("expected only b.md, got: %+v", resp.GetPaths())
	}
}

func TestServer_RenameFile_LocalSucceeds(t *testing.T) {
	s := newTestServer() // Connected=false -> local dispatch
	_, err := s.RenameFile(context.Background(), &gitgatewayv1.RenameFileRequest{WorktreeId: "wt-1", FromPath: "a.txt", ToPath: "b.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestServer_RenameFile_Connected_ReturnsFailedPrecondition(t *testing.T) {
	s := newTestServerWithResolver(&fakeResolver{conn: usecase.ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo"}})
	_, err := s.RenameFile(context.Background(), &gitgatewayv1.RenameFileRequest{WorktreeId: "wt-1", FromPath: "a.txt", ToPath: "b.txt"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition (known gap, BUG-009), got %v", err)
	}
}

func TestServer_CopyFile_LocalSucceeds(t *testing.T) {
	s := newTestServer()
	_, err := s.CopyFile(context.Background(), &gitgatewayv1.CopyFileRequest{WorktreeId: "wt-1", FromPath: "a.txt", ToPath: "b.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestServer_ReadFileChunk_Connected_ReturnsFailedPrecondition(t *testing.T) {
	s := newTestServerWithResolver(&fakeResolver{conn: usecase.ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo"}})
	_, err := s.ReadFileChunk(context.Background(), &gitgatewayv1.ReadFileChunkRequest{WorktreeId: "wt-1", Path: "a.txt"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition (known gap, BUG-009), got %v", err)
	}
}

// ── Group A — branch/ref operations (TASK-207) ─────────────────────────────

func TestServer_Checkout_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.Checkout(context.Background(), &gitgatewayv1.CheckoutRequest{WorktreeId: "wt-1", Branch: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() || resp.GetBranch() != "main" {
		t.Errorf("unexpected checkout response: %+v", resp)
	}
}

func TestServer_Checkout_MissingBranch_ReturnsInvalidArgument(t *testing.T) {
	s := newTestServer()
	_, err := s.Checkout(context.Background(), &gitgatewayv1.CheckoutRequest{WorktreeId: "wt-1"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestServer_ListLocalBranches_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.ListLocalBranches(context.Background(), &gitgatewayv1.ListLocalBranchesRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(resp.GetBranches()) != 1 || resp.GetBranches()[0].GetName() != "main" {
		t.Errorf("unexpected branches: %+v", resp.GetBranches())
	}
}

func TestServer_FastForward_TranslatesResult_WithPushTarget(t *testing.T) {
	s := newTestServer()
	resp, err := s.FastForward(context.Background(), &gitgatewayv1.FastForwardRequest{
		WorktreeId: "wt-1",
		PushTarget: &gitgatewayv1.PushTargetInput{RemoteName: "origin", BranchName: "main"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected fast-forward response: %+v", resp)
	}
}

func TestServer_FastForward_NilPushTarget_Allowed(t *testing.T) {
	s := newTestServer()
	resp, err := s.FastForward(context.Background(), &gitgatewayv1.FastForwardRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected fast-forward response: %+v", resp)
	}
}

func TestServer_RebaseFromBase_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.RebaseFromBase(context.Background(), &gitgatewayv1.RebaseFromBaseRequest{WorktreeId: "wt-1", BaseBranch: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected rebase-from-base response: %+v", resp)
	}
}

func TestServer_AbortRebase_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.AbortRebase(context.Background(), &gitgatewayv1.AbortRebaseRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected abort-rebase response: %+v", resp)
	}
}

func TestServer_AbortMerge_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.AbortMerge(context.Background(), &gitgatewayv1.AbortMergeRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected abort-merge response: %+v", resp)
	}
}

func TestServer_ConflictOperation_TranslatesDetectorResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.ConflictOperation(context.Background(), &gitgatewayv1.ConflictOperationRequest{WorktreeId: "wt-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetOperation() != "unknown" {
		t.Errorf("unexpected conflict-operation response: %+v", resp)
	}
}

func TestServer_ResolveConflict_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.ResolveConflict(context.Background(), &gitgatewayv1.ResolveConflictRequest{WorktreeId: "wt-1", Path: "a.txt", Operation: "ours"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected resolve-conflict response: %+v", resp)
	}
}

func TestServer_Discard_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.Discard(context.Background(), &gitgatewayv1.DiscardRequest{WorktreeId: "wt-1", Path: "a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected discard response: %+v", resp)
	}
}

func TestServer_BulkDiscard_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.BulkDiscard(context.Background(), &gitgatewayv1.BulkDiscardRequest{WorktreeId: "wt-1", Paths: []string{"a.txt"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected bulk-discard response: %+v", resp)
	}
}

// ── TASK-209 real shape redesign: CommitCompare/BranchCompare/CommitDiff/
// BranchDiff/SubmoduleStatus + TASK-210's Fetch ─────────────────────────────

func TestServer_UpstreamStatus_TranslatesStructuredPushTarget(t *testing.T) {
	s := newTestServer()
	resp, err := s.UpstreamStatus(context.Background(), &gitgatewayv1.UpstreamStatusRequest{
		WorktreeId: "wt-1", PushTarget: &gitgatewayv1.PushTargetInput{RemoteName: "origin", BranchName: "main"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetHasUpstream() {
		t.Errorf("unexpected upstream-status response: %+v", resp)
	}
}

func TestServer_CommitCompare_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.CommitCompare(context.Background(), &gitgatewayv1.CommitCompareRequest{WorktreeId: "wt-1", CommitId: "deadbeef"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetCommitOid() != "deadbeef" || resp.GetStatus() != "ready" || len(resp.GetEntries()) != 1 {
		t.Errorf("unexpected commit-compare response: %+v", resp)
	}
	if resp.GetEntries()[0].GetPath() != "a.txt" {
		t.Errorf("unexpected entries: %+v", resp.GetEntries())
	}
}

func TestServer_BranchCompare_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.BranchCompare(context.Background(), &gitgatewayv1.BranchCompareRequest{WorktreeId: "wt-1", BaseRef: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetCompareRef() != "feature" || resp.GetCommitsAhead() != 2 || len(resp.GetEntries()) != 1 {
		t.Errorf("unexpected branch-compare response: %+v", resp)
	}
}

func TestServer_CommitDiff_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.CommitDiff(context.Background(), &gitgatewayv1.CommitDiffRequest{
		WorktreeId: "wt-1", CommitOid: "deadbeef", FilePath: "a.txt",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetKind() != "text" || resp.GetOriginalContent() != "old" || resp.GetModifiedContent() != "new" {
		t.Errorf("unexpected commit-diff response: %+v", resp)
	}
}

func TestServer_CommitDiff_MissingFilePath_ReturnsInvalidArgument(t *testing.T) {
	s := newTestServer()
	_, err := s.CommitDiff(context.Background(), &gitgatewayv1.CommitDiffRequest{WorktreeId: "wt-1", CommitOid: "deadbeef"})
	if status.Code(err) != codes.InvalidArgument {
		t.Errorf("expected InvalidArgument for missing file_path, got %v", err)
	}
}

func TestServer_BranchDiff_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.BranchDiff(context.Background(), &gitgatewayv1.BranchDiffRequest{
		WorktreeId: "wt-1", BaseRef: "main", FilePath: "a.txt",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetKind() != "text" || resp.GetModifiedContent() != "new" {
		t.Errorf("unexpected branch-diff response: %+v", resp)
	}
}

func TestServer_SubmoduleStatus_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.SubmoduleStatus(context.Background(), &gitgatewayv1.SubmoduleStatusRequest{
		WorktreeId: "wt-1", SubmodulePath: "vendor/lib",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.GetBranch() != "main" || len(resp.GetFiles()) != 1 || resp.GetFiles()[0].GetPath() != "sub.txt" {
		t.Errorf("unexpected submodule-status response: %+v", resp)
	}
}

func TestServer_SubmoduleStatus_MissingSubmodulePath_ReturnsInvalidArgument(t *testing.T) {
	s := newTestServer()
	_, err := s.SubmoduleStatus(context.Background(), &gitgatewayv1.SubmoduleStatusRequest{WorktreeId: "wt-1"})
	if status.Code(err) != codes.InvalidArgument {
		t.Errorf("expected InvalidArgument for missing submodule_path, got %v", err)
	}
}

func TestServer_Fetch_TranslatesResult(t *testing.T) {
	s := newTestServer()
	resp, err := s.Fetch(context.Background(), &gitgatewayv1.FetchRequest{
		WorktreeId: "wt-1", PushTarget: &gitgatewayv1.PushTargetInput{RemoteName: "origin"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resp.GetSuccess() {
		t.Errorf("unexpected fetch response: %+v", resp)
	}
}
