package usecase

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
)

// fakeConnectionResolver is an in-memory ConnectionResolver — test against a
// fake, never a real infra-fleet-service call, per
// specs/backend-go/standards/testing-strategy.md's unit-test section.
type fakeConnectionResolver struct {
	conn ResolvedConnection
	err  error
}

func (f *fakeConnectionResolver) ResolveConnection(ctx context.Context, worktreeID string) (ResolvedConnection, error) {
	return f.conn, f.err
}

// fakeGitExecutor is a GitExecutor that records which of its methods was
// called, so tests can assert *which* executor (local vs. relay) a usecase
// dispatched to without either implementation doing real work.
type fakeGitExecutor struct {
	name string // "local" or "relay", for assertion messages

	calledGetStatus              bool
	calledGetDiff                bool
	calledCommit                 bool
	calledPush                   bool
	calledPull                   bool
	calledStage                  bool
	calledUnstage                bool
	calledHistory                bool
	calledCheckIgnored           bool
	calledForkSync               bool
	calledUpstreamState          bool
	calledRemoteCommit           bool
	calledRemoteFile             bool
	calledRemoteURL              bool
	calledClone                  bool
	calledInitRepo               bool
	calledBaseRefDefault         bool
	calledSearchRefs             bool
	calledCheckHooks             bool
	calledReadIssueCommand       bool
	calledWriteIssueCommand      bool
	calledScanSetupScriptImports bool
	calledCreateWorktree         bool
	calledRemoveWorktree         bool
	calledFetchAndResolve        bool
	calledListWorktreePaths      bool
	calledForceDeleteBranch      bool

	// Group C — real compare/diff/submodule shapes (TASK-209) + Fetch (TASK-210)
	calledCommitCompare   bool
	calledBranchCompare   bool
	calledCommitDiff      bool
	calledBranchDiff      bool
	calledSubmoduleStatus bool
	calledFetch           bool
	gotUpstreamPushTarget *domain.PushTargetInput
	gotFetchPushTarget    *domain.PushTargetInput
	commitCompareResult   domain.CommitCompareResult
	commitCompareErr      error
	branchCompareResult   domain.BranchCompareResult
	branchCompareErr      error
	commitDiffResult      domain.FileDiffResult
	commitDiffErr         error
	branchDiffResult      domain.FileDiffResult
	branchDiffErr         error
	submoduleStatusResult domain.GitStatus
	submoduleStatusErr    error
	fetchResult           domain.SimpleResult
	fetchErr              error

	// Group A — branch/ref operations (TASK-207)
	calledCheckout           bool
	calledListLocalBranches  bool
	calledFastForward        bool
	calledRebaseFromBase     bool
	calledAbortRebase        bool
	calledAbortMerge         bool
	calledConflictOperation  bool
	calledResolveConflict    bool
	calledDiscard            bool
	calledBulkDiscard        bool
	gotFastForwardPushTarget *domain.PushTargetInput
	gotBaseRef               string
	checkoutResult           domain.CheckoutResult
	checkoutErr              error
	branchInfos              []domain.BranchInfo
	listLocalBranchesErr     error
	fastForwardErr           error
	rebaseFromBaseErr        error
	conflictOperationResult  string
	conflictOperationErr     error
	resolveConflictErr       error
	discardErr               error
	bulkDiscardErr           error

	gotRepoPath string
	gotFilePath string

	statusErr                 error
	diffErr                   error
	commitErr                 error
	pushErr                   error
	pullErr                   error
	cloneErr                  error
	initRepoErr               error
	baseRefDefaultErr         error
	searchRefsErr             error
	checkHooksErr             error
	readIssueCommandErr       error
	writeIssueCommandErr      error
	scanSetupScriptImportsErr error
	createWorktreeErr         error
	removeWorktreeErr         error
	fetchAndResolveRefErr     error
	listWorktreePathsErr      error
	forceDeleteBranchErr      error

	// return values for the new methods, settable per-test
	worktreePath           string
	defaultBranch          string
	initPath               string
	baseRef                string
	remoteURL              string
	remoteURLErr           error
	refs                   []string
	installedHooks         []string
	orcaHooksCurrent       bool
	issueCommandContent    string
	issueCommandExists     bool
	setupScriptImportPaths []string

	createWorktreeResult  domain.WorktreeCreateResult
	fetchAndResolveRefSHA string
	listWorktreePathsOut  []domain.WorktreeGitInfo

	createWorktreeCallCount int
	removeWorktreeCallCount int
	gotRemoveWorktreePath   string
	gotRemoveWorktreeForce  bool
}

func (f *fakeGitExecutor) GetStatus(ctx context.Context, repoPath string) (domain.GitStatus, error) {
	f.calledGetStatus = true
	f.gotRepoPath = repoPath
	if f.statusErr != nil {
		return domain.GitStatus{}, f.statusErr
	}
	// One changed file so gatherFullDiff (used by GenerateCommitMessage /
	// GeneratePullRequestFields) actually calls GetDiff below.
	return domain.GitStatus{Branch: "main", Files: []domain.FileStatus{{Path: "file.txt", State: domain.FileStateModified}}}, nil
}

func (f *fakeGitExecutor) GetDiff(ctx context.Context, repoPath, filePath string, staged bool) (domain.DiffResult, error) {
	f.calledGetDiff = true
	f.gotRepoPath = repoPath
	f.gotFilePath = filePath
	if f.diffErr != nil {
		return domain.DiffResult{}, f.diffErr
	}
	return domain.DiffResult{UnifiedDiff: "diff"}, nil
}

func (f *fakeGitExecutor) Commit(ctx context.Context, repoPath, message string, paths []string) (domain.CommitResult, error) {
	f.calledCommit = true
	f.gotRepoPath = repoPath
	if f.commitErr != nil {
		return domain.CommitResult{}, f.commitErr
	}
	return domain.CommitResult{CommitSHA: "abc123"}, nil
}

func (f *fakeGitExecutor) Push(ctx context.Context, repoPath, remote, branch string) (domain.PushResult, error) {
	f.calledPush = true
	f.gotRepoPath = repoPath
	if f.pushErr != nil {
		return domain.PushResult{}, f.pushErr
	}
	return domain.PushResult{Success: true}, nil
}

func (f *fakeGitExecutor) Pull(ctx context.Context, repoPath string) (domain.PullResult, error) {
	f.calledPull = true
	f.gotRepoPath = repoPath
	if f.pullErr != nil {
		return domain.PullResult{}, f.pullErr
	}
	return domain.PullResult{Success: true}, nil
}

func (f *fakeGitExecutor) Stage(ctx context.Context, repoPath string, paths []string) (domain.SimpleResult, error) {
	f.calledStage = true
	f.gotRepoPath = repoPath
	return domain.SimpleResult{Success: true}, nil
}

func (f *fakeGitExecutor) Unstage(ctx context.Context, repoPath string, paths []string) (domain.SimpleResult, error) {
	f.calledUnstage = true
	f.gotRepoPath = repoPath
	return domain.SimpleResult{Success: true}, nil
}

func (f *fakeGitExecutor) History(ctx context.Context, repoPath, baseRef string, limit int) ([]domain.CommitRef, error) {
	f.calledHistory = true
	f.gotRepoPath = repoPath
	return []domain.CommitRef{{SHA: "abc123"}}, nil
}

func (f *fakeGitExecutor) CheckIgnored(ctx context.Context, repoPath string, paths []string) ([]string, error) {
	f.calledCheckIgnored = true
	f.gotRepoPath = repoPath
	return []string{}, nil
}

func (f *fakeGitExecutor) ForkSync(ctx context.Context, repoPath, expectedUpstream string) (domain.ForkSyncStatus, error) {
	f.calledForkSync = true
	f.gotRepoPath = repoPath
	return domain.ForkSyncStatus{}, nil
}

func (f *fakeGitExecutor) UpstreamStatus(ctx context.Context, repoPath string, pushTarget *domain.PushTargetInput) (domain.UpstreamStatus, error) {
	f.calledUpstreamState = true
	f.gotRepoPath = repoPath
	f.gotUpstreamPushTarget = pushTarget
	return domain.UpstreamStatus{}, nil
}

func (f *fakeGitExecutor) CommitCompare(ctx context.Context, repoPath, commitID string) (domain.CommitCompareResult, error) {
	f.calledCommitCompare = true
	f.gotRepoPath = repoPath
	if f.commitCompareErr != nil {
		return domain.CommitCompareResult{}, f.commitCompareErr
	}
	return f.commitCompareResult, nil
}

func (f *fakeGitExecutor) BranchCompare(ctx context.Context, repoPath, baseRef string) (domain.BranchCompareResult, error) {
	f.calledBranchCompare = true
	f.gotRepoPath = repoPath
	f.gotBaseRef = baseRef
	if f.branchCompareErr != nil {
		return domain.BranchCompareResult{}, f.branchCompareErr
	}
	return f.branchCompareResult, nil
}

func (f *fakeGitExecutor) CommitDiff(ctx context.Context, repoPath, commitOID, parentOID, filePath, oldPath string) (domain.FileDiffResult, error) {
	f.calledCommitDiff = true
	f.gotRepoPath = repoPath
	f.gotFilePath = filePath
	if f.commitDiffErr != nil {
		return domain.FileDiffResult{}, f.commitDiffErr
	}
	return f.commitDiffResult, nil
}

func (f *fakeGitExecutor) BranchDiff(ctx context.Context, repoPath, baseRef, filePath, oldPath string) (domain.FileDiffResult, error) {
	f.calledBranchDiff = true
	f.gotRepoPath = repoPath
	f.gotBaseRef = baseRef
	f.gotFilePath = filePath
	if f.branchDiffErr != nil {
		return domain.FileDiffResult{}, f.branchDiffErr
	}
	return f.branchDiffResult, nil
}

func (f *fakeGitExecutor) SubmoduleStatus(ctx context.Context, repoPath, submodulePath, area string) (domain.GitStatus, error) {
	f.calledSubmoduleStatus = true
	f.gotRepoPath = repoPath
	if f.submoduleStatusErr != nil {
		return domain.GitStatus{}, f.submoduleStatusErr
	}
	return f.submoduleStatusResult, nil
}

func (f *fakeGitExecutor) Fetch(ctx context.Context, repoPath string, pushTarget *domain.PushTargetInput) (domain.SimpleResult, error) {
	f.calledFetch = true
	f.gotRepoPath = repoPath
	f.gotFetchPushTarget = pushTarget
	if f.fetchErr != nil {
		return domain.SimpleResult{}, f.fetchErr
	}
	return f.fetchResult, nil
}

func (f *fakeGitExecutor) RemoteCommitURL(ctx context.Context, repoPath, sha string) (string, error) {
	f.calledRemoteCommit = true
	f.gotRepoPath = repoPath
	return "https://example.com/commit/" + sha, nil
}

func (f *fakeGitExecutor) RemoteFileURL(ctx context.Context, repoPath, path, ref string) (string, error) {
	f.calledRemoteFile = true
	f.gotRepoPath = repoPath
	return "https://example.com/blob/" + ref + "/" + path, nil
}

func (f *fakeGitExecutor) RemoteURL(ctx context.Context, repoPath, remoteName string) (string, error) {
	f.calledRemoteURL = true
	f.gotRepoPath = repoPath
	if f.remoteURLErr != nil {
		return "", f.remoteURLErr
	}
	return f.remoteURL, nil
}

func (f *fakeGitExecutor) Clone(ctx context.Context, url, destPath string) (string, string, error) {
	f.calledClone = true
	if f.cloneErr != nil {
		return "", "", f.cloneErr
	}
	return f.worktreePath, f.defaultBranch, nil
}

func (f *fakeGitExecutor) InitRepo(ctx context.Context, destPath, defaultBranch, remoteName, remoteURL string) (string, string, bool, error) {
	f.calledInitRepo = true
	if f.initRepoErr != nil {
		return "", "", false, f.initRepoErr
	}
	return f.initPath, f.defaultBranch, remoteURL != "", nil
}

func (f *fakeGitExecutor) BaseRefDefault(ctx context.Context, repoPath string) (string, error) {
	f.calledBaseRefDefault = true
	f.gotRepoPath = repoPath
	if f.baseRefDefaultErr != nil {
		return "", f.baseRefDefaultErr
	}
	return f.baseRef, nil
}

func (f *fakeGitExecutor) SearchRefs(ctx context.Context, repoPath, query string) ([]string, error) {
	f.calledSearchRefs = true
	f.gotRepoPath = repoPath
	if f.searchRefsErr != nil {
		return nil, f.searchRefsErr
	}
	return f.refs, nil
}

func (f *fakeGitExecutor) CheckHooks(ctx context.Context, repoPath string) ([]string, bool, error) {
	f.calledCheckHooks = true
	f.gotRepoPath = repoPath
	if f.checkHooksErr != nil {
		return nil, false, f.checkHooksErr
	}
	return f.installedHooks, f.orcaHooksCurrent, nil
}

func (f *fakeGitExecutor) ReadIssueCommand(ctx context.Context, repoPath string) (string, bool, error) {
	f.calledReadIssueCommand = true
	f.gotRepoPath = repoPath
	if f.readIssueCommandErr != nil {
		return "", false, f.readIssueCommandErr
	}
	return f.issueCommandContent, f.issueCommandExists, nil
}

func (f *fakeGitExecutor) WriteIssueCommand(ctx context.Context, repoPath, content string) error {
	f.calledWriteIssueCommand = true
	f.gotRepoPath = repoPath
	return f.writeIssueCommandErr
}

func (f *fakeGitExecutor) ScanSetupScriptImports(ctx context.Context, repoPath string) ([]string, error) {
	f.calledScanSetupScriptImports = true
	f.gotRepoPath = repoPath
	if f.scanSetupScriptImportsErr != nil {
		return nil, f.scanSetupScriptImportsErr
	}
	return f.setupScriptImportPaths, nil
}

// fakeDevServerReachability is an in-memory DevServerReachability, for
// Clone/InitRepo's tests — same fake-not-real-call convention as
// fakeConnectionResolver.
type fakeDevServerReachability struct {
	reachable bool
	err       error
}

func (f *fakeDevServerReachability) IsReachable(ctx context.Context, devServerID string) (bool, error) {
	return f.reachable, f.err
}

func (f *fakeGitExecutor) CreateWorktree(ctx context.Context, repoPath, branch, baseRef string) (domain.WorktreeCreateResult, error) {
	f.calledCreateWorktree = true
	f.createWorktreeCallCount++
	f.gotRepoPath = repoPath
	if f.createWorktreeErr != nil {
		return domain.WorktreeCreateResult{}, f.createWorktreeErr
	}
	if f.createWorktreeResult != (domain.WorktreeCreateResult{}) {
		return f.createWorktreeResult, nil
	}
	return domain.WorktreeCreateResult{Path: repoPath + "-" + branch, HeadSHA: "deadbeef"}, nil
}

func (f *fakeGitExecutor) RemoveWorktree(ctx context.Context, worktreePath string, force bool) error {
	f.calledRemoveWorktree = true
	f.removeWorktreeCallCount++
	f.gotRepoPath = worktreePath
	f.gotRemoveWorktreePath = worktreePath
	f.gotRemoveWorktreeForce = force
	return f.removeWorktreeErr
}

func (f *fakeGitExecutor) FetchAndResolveRef(ctx context.Context, repoPath, ref string) (string, error) {
	f.calledFetchAndResolve = true
	f.gotRepoPath = repoPath
	if f.fetchAndResolveRefErr != nil {
		return "", f.fetchAndResolveRefErr
	}
	if f.fetchAndResolveRefSHA != "" {
		return f.fetchAndResolveRefSHA, nil
	}
	return "resolvedsha", nil
}

func (f *fakeGitExecutor) ListWorktreePaths(ctx context.Context, repoPath string) ([]domain.WorktreeGitInfo, error) {
	f.calledListWorktreePaths = true
	f.gotRepoPath = repoPath
	if f.listWorktreePathsErr != nil {
		return nil, f.listWorktreePathsErr
	}
	return f.listWorktreePathsOut, nil
}

func (f *fakeGitExecutor) ForceDeleteBranch(ctx context.Context, repoPath, branch string) error {
	f.calledForceDeleteBranch = true
	f.gotRepoPath = repoPath
	return f.forceDeleteBranchErr
}

// ── Group A — branch/ref operations (TASK-207) ─────────────────────────────

func (f *fakeGitExecutor) Checkout(ctx context.Context, repoPath, branch string) (domain.CheckoutResult, error) {
	f.calledCheckout = true
	f.gotRepoPath = repoPath
	if f.checkoutErr != nil {
		return domain.CheckoutResult{}, f.checkoutErr
	}
	if f.checkoutResult != (domain.CheckoutResult{}) {
		return f.checkoutResult, nil
	}
	return domain.CheckoutResult{Success: true, Branch: branch}, nil
}

func (f *fakeGitExecutor) ListLocalBranches(ctx context.Context, repoPath string) ([]domain.BranchInfo, error) {
	f.calledListLocalBranches = true
	f.gotRepoPath = repoPath
	if f.listLocalBranchesErr != nil {
		return nil, f.listLocalBranchesErr
	}
	if f.branchInfos != nil {
		return f.branchInfos, nil
	}
	return []domain.BranchInfo{{Name: "main", IsCurrent: true}}, nil
}

func (f *fakeGitExecutor) FastForward(ctx context.Context, repoPath string, pushTarget *domain.PushTargetInput) (domain.FastForwardResult, error) {
	f.calledFastForward = true
	f.gotRepoPath = repoPath
	f.gotFastForwardPushTarget = pushTarget
	if f.fastForwardErr != nil {
		return domain.FastForwardResult{}, f.fastForwardErr
	}
	return domain.FastForwardResult{Success: true}, nil
}

func (f *fakeGitExecutor) RebaseFromBase(ctx context.Context, repoPath, baseRef string) (domain.RebaseResult, error) {
	f.calledRebaseFromBase = true
	f.gotRepoPath = repoPath
	f.gotBaseRef = baseRef
	if f.rebaseFromBaseErr != nil {
		return domain.RebaseResult{}, f.rebaseFromBaseErr
	}
	return domain.RebaseResult{Success: true}, nil
}

func (f *fakeGitExecutor) AbortRebase(ctx context.Context, repoPath string) (domain.SimpleResult, error) {
	f.calledAbortRebase = true
	f.gotRepoPath = repoPath
	return domain.SimpleResult{Success: true}, nil
}

func (f *fakeGitExecutor) AbortMerge(ctx context.Context, repoPath string) (domain.SimpleResult, error) {
	f.calledAbortMerge = true
	f.gotRepoPath = repoPath
	return domain.SimpleResult{Success: true}, nil
}

func (f *fakeGitExecutor) ConflictOperation(ctx context.Context, repoPath string) (string, error) {
	f.calledConflictOperation = true
	f.gotRepoPath = repoPath
	if f.conflictOperationErr != nil {
		return "", f.conflictOperationErr
	}
	if f.conflictOperationResult != "" {
		return f.conflictOperationResult, nil
	}
	return "unknown", nil
}

func (f *fakeGitExecutor) ResolveConflict(ctx context.Context, repoPath, path, operation string) (domain.SimpleResult, error) {
	f.calledResolveConflict = true
	f.gotRepoPath = repoPath
	if f.resolveConflictErr != nil {
		return domain.SimpleResult{}, f.resolveConflictErr
	}
	return domain.SimpleResult{Success: true}, nil
}

func (f *fakeGitExecutor) Discard(ctx context.Context, repoPath, path string) (domain.SimpleResult, error) {
	f.calledDiscard = true
	f.gotRepoPath = repoPath
	if f.discardErr != nil {
		return domain.SimpleResult{}, f.discardErr
	}
	return domain.SimpleResult{Success: true}, nil
}

func (f *fakeGitExecutor) BulkDiscard(ctx context.Context, repoPath string, paths []string) (domain.BulkDiscardResult, error) {
	f.calledBulkDiscard = true
	f.gotRepoPath = repoPath
	if f.bulkDiscardErr != nil {
		return domain.BulkDiscardResult{}, f.bulkDiscardErr
	}
	return domain.BulkDiscardResult{Success: true}, nil
}

func TestGetStatus_NotConnected_RoutesToLocalExecutor(t *testing.T) {
	resolver := &fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo/wt1"}}
	local := &fakeGitExecutor{name: "local"}
	relay := &fakeGitExecutor{name: "relay"}
	uc := NewGetStatus(resolver, local, relay)

	got, err := uc.Execute(context.Background(), GetStatusInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledGetStatus {
		t.Error("expected local executor to be called when Connected=false")
	}
	if relay.calledGetStatus {
		t.Error("expected relay executor NOT to be called when Connected=false")
	}
	if local.gotRepoPath != "/repo/wt1" {
		t.Errorf("expected resolved repo path to be passed through, got %q", local.gotRepoPath)
	}
	if got.Branch != "main" {
		t.Errorf("expected result from local executor, got %+v", got)
	}
}

func TestGetStatus_Connected_RoutesToRelayExecutor(t *testing.T) {
	resolver := &fakeConnectionResolver{conn: ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo/wt1"}}
	local := &fakeGitExecutor{name: "local"}
	relay := &fakeGitExecutor{name: "relay"}
	uc := NewGetStatus(resolver, local, relay)

	_, err := uc.Execute(context.Background(), GetStatusInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledGetStatus {
		t.Error("expected relay executor to be called when Connected=true")
	}
	if local.calledGetStatus {
		t.Error("expected local executor NOT to be called when Connected=true")
	}
}

func TestGetStatus_MissingWorktreeID_ReturnsError(t *testing.T) {
	uc := NewGetStatus(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), GetStatusInput{})
	if err == nil {
		t.Fatal("expected error for missing worktree_id")
	}
}

func TestGetStatus_ResolverFailure_Propagates(t *testing.T) {
	resolver := &fakeConnectionResolver{err: errors.New("infra-fleet-service unreachable")}
	uc := NewGetStatus(resolver, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), GetStatusInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected resolver error to propagate")
	}
}

func TestGetDiff_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewGetDiff(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), GetDiffInput{WorktreeID: "wt1", FilePath: "README.md", Staged: true})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledGetDiff || local.calledGetDiff {
		t.Error("expected GetDiff to route to relay when Connected=true")
	}
	if got.UnifiedDiff != "diff" {
		t.Errorf("unexpected diff result: %+v", got)
	}
}

func TestGetDiff_MissingFilePath_ReturnsError(t *testing.T) {
	uc := NewGetDiff(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), GetDiffInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing file_path")
	}
}

func TestCommit_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewCommit(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), CommitInput{WorktreeID: "wt1", Message: "fix bug"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledCommit || relay.calledCommit {
		t.Error("expected Commit to route to local when Connected=false")
	}
	if got.CommitSHA != "abc123" {
		t.Errorf("unexpected commit result: %+v", got)
	}
}

func TestCommit_MissingMessage_ReturnsError(t *testing.T) {
	uc := NewCommit(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), CommitInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing commit message")
	}
}

func TestPush_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewPush(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), PushInput{WorktreeID: "wt1", Remote: "origin", Branch: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledPush || local.calledPush {
		t.Error("expected Push to route to relay when Connected=true")
	}
	if !got.Success {
		t.Errorf("unexpected push result: %+v", got)
	}
}

func TestPull_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewPull(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), PullInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledPull || relay.calledPull {
		t.Error("expected Pull to route to local when Connected=false")
	}
	if !got.Success {
		t.Errorf("unexpected pull result: %+v", got)
	}
}

// fakeAICompleter is an in-memory usecase.AICompleter — records the
// connectionID/prompt it was called with so tests can assert
// GenerateCommitMessage threads the resolved connection through correctly.
type fakeAICompleter struct {
	called          bool
	gotConnectionID string
	gotPrompt       string
	message         string
	err             error
}

func (f *fakeAICompleter) Complete(ctx context.Context, connectionID, prompt string) (string, error) {
	f.called = true
	f.gotConnectionID = connectionID
	f.gotPrompt = prompt
	if f.err != nil {
		return "", f.err
	}
	return f.message, nil
}

func TestGenerateCommitMessage_Connected_RelaysDiffAndReturnsMessage(t *testing.T) {
	resolver := &fakeConnectionResolver{conn: ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo/wt1"}}
	local := &fakeGitExecutor{name: "local"}
	relay := &fakeGitExecutor{name: "relay"}
	getStatus := NewGetStatus(resolver, local, relay)
	getDiff := NewGetDiff(resolver, local, relay)
	completer := &fakeAICompleter{message: "feat: add widget"}
	uc := NewGenerateCommitMessage(resolver, getStatus, getDiff, completer)

	got, err := uc.Execute(context.Background(), GenerateCommitMessageInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "feat: add widget" {
		t.Errorf("expected generated message to pass through, got %q", got)
	}
	if !relay.calledGetDiff || local.calledGetDiff {
		t.Error("expected diff to be fetched via relay when Connected=true")
	}
	if !completer.called {
		t.Fatal("expected AICompleter.Complete to be called")
	}
	if completer.gotConnectionID != "conn-1" {
		t.Errorf("expected resolved ConnectionID to be passed through, got %q", completer.gotConnectionID)
	}
	if !strings.Contains(completer.gotPrompt, "diff") {
		t.Errorf("expected prompt to include the fetched diff, got %q", completer.gotPrompt)
	}
}

func TestGenerateCommitMessage_NotConnected_ReturnsFailedPrecondition(t *testing.T) {
	resolver := &fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo/wt1"}}
	getStatus := NewGetStatus(resolver, &fakeGitExecutor{}, &fakeGitExecutor{})
	getDiff := NewGetDiff(resolver, &fakeGitExecutor{}, &fakeGitExecutor{})
	completer := &fakeAICompleter{message: "should not be called"}
	uc := NewGenerateCommitMessage(resolver, getStatus, getDiff, completer)

	_, err := uc.Execute(context.Background(), GenerateCommitMessageInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error when worktree has no relay connection")
	}
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition AppError, got %v", err)
	}
	if completer.called {
		t.Error("expected AICompleter NOT to be called when there is no relay connection")
	}
}

func TestGenerateCommitMessage_RelayFailure_Propagates(t *testing.T) {
	resolver := &fakeConnectionResolver{conn: ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo/wt1"}}
	getStatus := NewGetStatus(resolver, &fakeGitExecutor{}, &fakeGitExecutor{})
	getDiff := NewGetDiff(resolver, &fakeGitExecutor{}, &fakeGitExecutor{})
	completer := &fakeAICompleter{err: errors.New("dev server agent unreachable")}
	uc := NewGenerateCommitMessage(resolver, getStatus, getDiff, completer)

	_, err := uc.Execute(context.Background(), GenerateCommitMessageInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected relay failure to propagate as an error, not be swallowed")
	}
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindInternal {
		t.Fatalf("expected KindInternal AppError, got %v", err)
	}
}

func TestGenerateCommitMessage_MissingWorktreeID_ReturnsError(t *testing.T) {
	emptyResolver := &fakeConnectionResolver{}
	uc := NewGenerateCommitMessage(emptyResolver, NewGetStatus(emptyResolver, &fakeGitExecutor{}, &fakeGitExecutor{}), NewGetDiff(emptyResolver, &fakeGitExecutor{}, &fakeGitExecutor{}), &fakeAICompleter{})
	_, err := uc.Execute(context.Background(), GenerateCommitMessageInput{})
	if err == nil {
		t.Fatal("expected error for missing worktree_id")
	}
}

// ── TASK-208: Stage/Unstage ───────────────────────────────────────────────

func TestStage_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewStage(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), StageInput{WorktreeID: "wt1", Paths: []string{"a.txt"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledStage || local.calledStage {
		t.Error("expected Stage to route to relay when Connected=true")
	}
	if !got.Success {
		t.Errorf("unexpected stage result: %+v", got)
	}
}

func TestStage_MissingPaths_ReturnsError(t *testing.T) {
	uc := NewStage(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), StageInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing paths")
	}
}

func TestUnstage_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewUnstage(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), UnstageInput{WorktreeID: "wt1", Paths: []string{"a.txt"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledUnstage || relay.calledUnstage {
		t.Error("expected Unstage to route to local when Connected=false")
	}
	if !got.Success {
		t.Errorf("unexpected unstage result: %+v", got)
	}
}

func TestUnstage_MissingPaths_ReturnsError(t *testing.T) {
	uc := NewUnstage(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), UnstageInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing paths")
	}
}

// ── TASK-209 (shippable-now subset): History/CheckIgnored/ForkSync/UpstreamStatus ──

func TestHistory_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewHistory(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), HistoryInput{WorktreeID: "wt1", BaseRef: "main", Limit: 10})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledHistory || local.calledHistory {
		t.Error("expected History to route to relay when Connected=true")
	}
	if len(got.Commits) != 1 {
		t.Errorf("unexpected history result: %+v", got)
	}
}

func TestCheckIgnored_MissingPaths_ReturnsError(t *testing.T) {
	uc := NewCheckIgnored(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), CheckIgnoredInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing paths")
	}
}

func TestCheckIgnored_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewCheckIgnored(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	_, err := uc.Execute(context.Background(), CheckIgnoredInput{WorktreeID: "wt1", Paths: []string{"node_modules"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledCheckIgnored || relay.calledCheckIgnored {
		t.Error("expected CheckIgnored to route to local when Connected=false")
	}
}

func TestForkSync_MissingExpectedUpstream_ReturnsError(t *testing.T) {
	uc := NewForkSync(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), ForkSyncInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing expected_upstream — real agent requires it (TASK-209)")
	}
}

func TestForkSync_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewForkSync(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	_, err := uc.Execute(context.Background(), ForkSyncInput{WorktreeID: "wt1", ExpectedUpstream: "origin/main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledForkSync || local.calledForkSync {
		t.Error("expected ForkSync to route to relay when Connected=true")
	}
}

func TestUpstreamStatus_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewUpstreamStatus(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	_, err := uc.Execute(context.Background(), UpstreamStatusInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledUpstreamState || relay.calledUpstreamState {
		t.Error("expected UpstreamStatus to route to local when Connected=false")
	}
}

// ── TASK-210 (shippable-now subset): RemoteCommitURL/RemoteFileURL ───────

func TestRemoteCommitURL_MissingSHA_ReturnsError(t *testing.T) {
	uc := NewRemoteCommitURL(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), RemoteCommitURLInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing sha")
	}
}

func TestRemoteCommitURL_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewRemoteCommitURL(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), RemoteCommitURLInput{WorktreeID: "wt1", SHA: "deadbeef"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledRemoteCommit || relay.calledRemoteCommit {
		t.Error("expected RemoteCommitURL to route to local when Connected=false")
	}
	if got == "" {
		t.Error("expected non-empty url")
	}
}

func TestRemoteFileURL_MissingPath_ReturnsError(t *testing.T) {
	uc := NewRemoteFileURL(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), RemoteFileURLInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestRemoteFileURL_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewRemoteFileURL(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, ConnectionID: "conn-1"}}, local, relay)

	got, err := uc.Execute(context.Background(), RemoteFileURLInput{WorktreeID: "wt1", Path: "a.txt", Ref: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledRemoteFile || local.calledRemoteFile {
		t.Error("expected RemoteFileURL to route to relay when Connected=true")
	}
	if got == "" {
		t.Error("expected non-empty url")
	}
}

// ── TASK-211: GeneratePullRequestFields/DiscoverCommitMessageModels ──────

func TestGeneratePullRequestFields_Connected_RelaysDiffAndReturnsFields(t *testing.T) {
	resolver := &fakeConnectionResolver{conn: ResolvedConnection{Connected: true, ConnectionID: "conn-1", RepoPath: "/repo/wt1"}}
	local := &fakeGitExecutor{name: "local"}
	relay := &fakeGitExecutor{name: "relay"}
	getStatus := NewGetStatus(resolver, local, relay)
	getDiff := NewGetDiff(resolver, local, relay)
	completer := &fakeAICompleter{message: "Add widget\n\nImplements the widget feature."}
	uc := NewGeneratePullRequestFields(resolver, getStatus, getDiff, completer)

	got, err := uc.Execute(context.Background(), GeneratePullRequestFieldsInput{WorktreeID: "wt1", BaseBranch: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Title != "Add widget" {
		t.Errorf("expected title=%q, got %q", "Add widget", got.Title)
	}
	if got.Description != "\nImplements the widget feature." {
		t.Errorf("unexpected description: %q", got.Description)
	}
}

func TestGeneratePullRequestFields_NotConnected_ReturnsFailedPrecondition(t *testing.T) {
	resolver := &fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}
	getStatus := NewGetStatus(resolver, &fakeGitExecutor{}, &fakeGitExecutor{})
	getDiff := NewGetDiff(resolver, &fakeGitExecutor{}, &fakeGitExecutor{})
	uc := NewGeneratePullRequestFields(resolver, getStatus, getDiff, &fakeAICompleter{})

	_, err := uc.Execute(context.Background(), GeneratePullRequestFieldsInput{WorktreeID: "wt1"})
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition AppError, got %v", err)
	}
}

func TestParsePRFields_NoNewline_TitleOnly(t *testing.T) {
	got := parsePRFields("just a title, no newline")
	if got.Title != "just a title, no newline" || got.Description != "" {
		t.Errorf("unexpected parse result: %+v", got)
	}
}

// fakeAIProviderResolver is an in-memory usecase.AIProviderResolver.
type fakeAIProviderResolver struct {
	providerType, accountID, status string
	err                             error
}

func (f *fakeAIProviderResolver) ResolveProvider(ctx context.Context, tenantID, userID string) (string, string, string, error) {
	if f.err != nil {
		return "", "", "", f.err
	}
	return f.providerType, f.accountID, f.status, nil
}

func TestDiscoverCommitMessageModels_ReturnsResolvedAccount(t *testing.T) {
	uc := NewDiscoverCommitMessageModels(&fakeAIProviderResolver{providerType: "PROVIDER_TYPE_ANTHROPIC", accountID: "acct-1", status: "active"})
	got, err := uc.Execute(context.Background(), DiscoverCommitMessageModelsInput{TenantID: "t-1", UserID: "u-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].AccountID != "acct-1" {
		t.Errorf("unexpected models: %+v", got)
	}
}

func TestDiscoverCommitMessageModels_NoAccount_ReturnsEmpty(t *testing.T) {
	uc := NewDiscoverCommitMessageModels(&fakeAIProviderResolver{})
	got, err := uc.Execute(context.Background(), DiscoverCommitMessageModelsInput{TenantID: "t-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 models when ResolveProvider finds no account, got %+v", got)
	}
}

func TestDiscoverCommitMessageModels_MissingTenantID_ReturnsError(t *testing.T) {
	uc := NewDiscoverCommitMessageModels(&fakeAIProviderResolver{})
	_, err := uc.Execute(context.Background(), DiscoverCommitMessageModelsInput{})
	if err == nil {
		t.Fatal("expected error for missing tenant_id")
	}
}

// ── TASK-207: Group A — branch/ref operations ───────────────────────────────

func TestCheckout_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewCheckout(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), CheckoutInput{WorktreeID: "wt1", Branch: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledCheckout || local.calledCheckout {
		t.Error("expected Checkout to route to relay when Connected=true")
	}
	if !got.Success || got.Branch != "main" {
		t.Errorf("unexpected checkout result: %+v", got)
	}
}

func TestCheckout_MissingBranch_ReturnsError(t *testing.T) {
	uc := NewCheckout(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), CheckoutInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing branch")
	}
}

func TestListLocalBranches_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{branchInfos: []domain.BranchInfo{{Name: "main", IsCurrent: true}, {Name: "feature/x"}}}
	uc := NewListLocalBranches(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), ListLocalBranchesInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledListLocalBranches || local.calledListLocalBranches {
		t.Error("expected ListLocalBranches to route to relay when Connected=true")
	}
	if len(got) != 2 {
		t.Errorf("unexpected branches: %+v", got)
	}
}

func TestListLocalBranches_MissingWorktreeID_ReturnsError(t *testing.T) {
	uc := NewListLocalBranches(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), ListLocalBranchesInput{})
	if err == nil {
		t.Fatal("expected error for missing worktree_id")
	}
}

func TestFastForward_RoutesByConnectionState_AndThreadsPushTarget(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewFastForward(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	pushTarget := &domain.PushTargetInput{RemoteName: "origin", BranchName: "main"}
	got, err := uc.Execute(context.Background(), FastForwardInput{WorktreeID: "wt1", PushTarget: pushTarget})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledFastForward || local.calledFastForward {
		t.Error("expected FastForward to route to relay when Connected=true")
	}
	if relay.gotFastForwardPushTarget != pushTarget {
		t.Errorf("expected pushTarget to be threaded through, got %+v", relay.gotFastForwardPushTarget)
	}
	if !got.Success {
		t.Errorf("unexpected fast-forward result: %+v", got)
	}
}

func TestFastForward_NilPushTarget_Allowed(t *testing.T) {
	local := &fakeGitExecutor{}
	uc := NewFastForward(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, &fakeGitExecutor{})

	_, err := uc.Execute(context.Background(), FastForwardInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if local.gotFastForwardPushTarget != nil {
		t.Errorf("expected nil pushTarget to pass through as nil, got %+v", local.gotFastForwardPushTarget)
	}
}

func TestRebaseFromBase_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewRebaseFromBase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), RebaseFromBaseInput{WorktreeID: "wt1", BaseRef: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledRebaseFromBase || relay.calledRebaseFromBase {
		t.Error("expected RebaseFromBase to route to local when Connected=false")
	}
	if local.gotBaseRef != "main" {
		t.Errorf("expected base_ref to be threaded through, got %q", local.gotBaseRef)
	}
	if !got.Success {
		t.Errorf("unexpected rebase result: %+v", got)
	}
}

func TestRebaseFromBase_MissingBaseRef_ReturnsError(t *testing.T) {
	uc := NewRebaseFromBase(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), RebaseFromBaseInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing base_ref")
	}
}

func TestAbortRebase_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewAbortRebase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), AbortRebaseInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledAbortRebase || local.calledAbortRebase {
		t.Error("expected AbortRebase to route to relay when Connected=true")
	}
	if !got.Success {
		t.Errorf("unexpected abort-rebase result: %+v", got)
	}
}

func TestAbortMerge_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewAbortMerge(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), AbortMergeInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledAbortMerge || relay.calledAbortMerge {
		t.Error("expected AbortMerge to route to local when Connected=false")
	}
	if !got.Success {
		t.Errorf("unexpected abort-merge result: %+v", got)
	}
}

func TestConflictOperation_RoutesByConnectionState_AndReturnsDetectorResult(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{conflictOperationResult: "rebase"}
	uc := NewConflictOperation(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), ConflictOperationInput{WorktreeID: "wt1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledConflictOperation || local.calledConflictOperation {
		t.Error("expected ConflictOperation to route to relay when Connected=true")
	}
	if got != "rebase" {
		t.Errorf("expected detector result to pass through, got %q", got)
	}
}

func TestConflictOperation_MissingWorktreeID_ReturnsError(t *testing.T) {
	uc := NewConflictOperation(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), ConflictOperationInput{})
	if err == nil {
		t.Fatal("expected error for missing worktree_id")
	}
}

func TestResolveConflict_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewResolveConflict(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), ResolveConflictInput{WorktreeID: "wt1", Path: "a.txt", Operation: "ours"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledResolveConflict || relay.calledResolveConflict {
		t.Error("expected ResolveConflict to route to local when Connected=false")
	}
	if !got.Success {
		t.Errorf("unexpected resolve-conflict result: %+v", got)
	}
}

func TestResolveConflict_MissingFields_ReturnsError(t *testing.T) {
	uc := NewResolveConflict(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	if _, err := uc.Execute(context.Background(), ResolveConflictInput{WorktreeID: "wt1"}); err == nil {
		t.Fatal("expected error for missing path")
	}
	if _, err := uc.Execute(context.Background(), ResolveConflictInput{WorktreeID: "wt1", Path: "a.txt"}); err == nil {
		t.Fatal("expected error for missing operation")
	}
}

func TestResolveConflict_UnsupportedOverRelay_ReturnsFailedPrecondition(t *testing.T) {
	relay := &fakeGitExecutor{resolveConflictErr: domain.ErrConflictResolveUnsupportedOverRelay}
	uc := NewResolveConflict(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, &fakeGitExecutor{}, relay)

	_, err := uc.Execute(context.Background(), ResolveConflictInput{WorktreeID: "wt1", Path: "a.txt", Operation: "ours"})
	var ae *apperrors.AppError
	if !errors.As(err, &ae) || ae.Kind != apperrors.KindFailedPrecondition {
		t.Fatalf("expected KindFailedPrecondition AppError, got %v", err)
	}
}

func TestDiscard_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewDiscard(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), DiscardInput{WorktreeID: "wt1", Path: "a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledDiscard || local.calledDiscard {
		t.Error("expected Discard to route to relay when Connected=true")
	}
	if !got.Success {
		t.Errorf("unexpected discard result: %+v", got)
	}
}

func TestDiscard_MissingPath_ReturnsError(t *testing.T) {
	uc := NewDiscard(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), DiscardInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestBulkDiscard_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewBulkDiscard(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), BulkDiscardInput{WorktreeID: "wt1", Paths: []string{"a.txt", "b.txt"}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledBulkDiscard || relay.calledBulkDiscard {
		t.Error("expected BulkDiscard to route to local when Connected=false")
	}
	if !got.Success {
		t.Errorf("unexpected bulk-discard result: %+v", got)
	}
}

func TestBulkDiscard_MissingPaths_ReturnsError(t *testing.T) {
	uc := NewBulkDiscard(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), BulkDiscardInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing paths")
	}
}

// ── TASK-209 real shape redesign: CommitCompare/BranchCompare/CommitDiff/
// BranchDiff/SubmoduleStatus + TASK-210's Fetch ─────────────────────────────

func TestCommitCompare_MissingCommitID_ReturnsError(t *testing.T) {
	uc := NewCommitCompare(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), CommitCompareInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing commit_id")
	}
}

func TestCommitCompare_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{commitCompareResult: domain.CommitCompareResult{CommitOID: "deadbeef", Status: "ready"}}
	uc := NewCommitCompare(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), CommitCompareInput{WorktreeID: "wt1", CommitID: "deadbeef"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledCommitCompare || local.calledCommitCompare {
		t.Error("expected CommitCompare to route to relay when Connected=true")
	}
	if got.CommitOID != "deadbeef" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestBranchCompare_MissingBaseRef_ReturnsError(t *testing.T) {
	uc := NewBranchCompare(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), BranchCompareInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing base_ref")
	}
}

func TestBranchCompare_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{branchCompareResult: domain.BranchCompareResult{Status: "ready"}}
	relay := &fakeGitExecutor{}
	uc := NewBranchCompare(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	_, err := uc.Execute(context.Background(), BranchCompareInput{WorktreeID: "wt1", BaseRef: "main"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledBranchCompare || relay.calledBranchCompare {
		t.Error("expected BranchCompare to route to local when Connected=false")
	}
	if local.gotBaseRef != "main" {
		t.Errorf("expected baseRef to be forwarded, got %q", local.gotBaseRef)
	}
}

func TestCommitDiff_MissingFilePath_ReturnsError(t *testing.T) {
	uc := NewCommitDiff(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), CommitDiffInput{WorktreeID: "wt1", CommitOID: "deadbeef"})
	if err == nil {
		t.Fatal("expected error for missing file_path")
	}
}

func TestCommitDiff_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{commitDiffResult: domain.FileDiffResult{Kind: "text", ModifiedContent: "new"}}
	uc := NewCommitDiff(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	got, err := uc.Execute(context.Background(), CommitDiffInput{WorktreeID: "wt1", CommitOID: "deadbeef", FilePath: "a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledCommitDiff || local.calledCommitDiff {
		t.Error("expected CommitDiff to route to relay when Connected=true")
	}
	if got.ModifiedContent != "new" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestBranchDiff_MissingFilePath_ReturnsError(t *testing.T) {
	uc := NewBranchDiff(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), BranchDiffInput{WorktreeID: "wt1", BaseRef: "main"})
	if err == nil {
		t.Fatal("expected error for missing file_path")
	}
}

func TestBranchDiff_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewBranchDiff(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)

	_, err := uc.Execute(context.Background(), BranchDiffInput{WorktreeID: "wt1", BaseRef: "main", FilePath: "a.txt"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledBranchDiff || local.calledBranchDiff {
		t.Error("expected BranchDiff to route to relay when Connected=true")
	}
	if relay.gotBaseRef != "main" || relay.gotFilePath != "a.txt" {
		t.Errorf("expected baseRef/filePath to be forwarded, got baseRef=%q filePath=%q", relay.gotBaseRef, relay.gotFilePath)
	}
}

func TestSubmoduleStatus_MissingSubmodulePath_ReturnsError(t *testing.T) {
	uc := NewSubmoduleStatus(&fakeConnectionResolver{}, &fakeGitExecutor{}, &fakeGitExecutor{})
	_, err := uc.Execute(context.Background(), SubmoduleStatusInput{WorktreeID: "wt1"})
	if err == nil {
		t.Fatal("expected error for missing submodule_path")
	}
}

func TestSubmoduleStatus_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{submoduleStatusResult: domain.GitStatus{Branch: "main"}}
	relay := &fakeGitExecutor{}
	uc := NewSubmoduleStatus(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	got, err := uc.Execute(context.Background(), SubmoduleStatusInput{WorktreeID: "wt1", SubmodulePath: "vendor/lib"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledSubmoduleStatus || relay.calledSubmoduleStatus {
		t.Error("expected SubmoduleStatus to route to local when Connected=false")
	}
	if got.Branch != "main" {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestFetch_RoutesByConnectionState(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{fetchResult: domain.SimpleResult{Success: true}}
	uc := NewFetch(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local, relay)
	pushTarget := &domain.PushTargetInput{RemoteName: "origin"}

	got, err := uc.Execute(context.Background(), FetchInput{WorktreeID: "wt1", PushTarget: pushTarget})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledFetch || local.calledFetch {
		t.Error("expected Fetch to route to relay when Connected=true")
	}
	if relay.gotFetchPushTarget != pushTarget {
		t.Errorf("expected pushTarget to be forwarded, got %+v", relay.gotFetchPushTarget)
	}
	if !got.Success {
		t.Errorf("unexpected result: %+v", got)
	}
}

func TestUpstreamStatus_ForwardsPushTarget(t *testing.T) {
	local := &fakeGitExecutor{}
	relay := &fakeGitExecutor{}
	uc := NewUpstreamStatus(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)
	pushTarget := &domain.PushTargetInput{RemoteName: "origin", BranchName: "main"}

	_, err := uc.Execute(context.Background(), UpstreamStatusInput{WorktreeID: "wt1", PushTarget: pushTarget})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if local.gotUpstreamPushTarget != pushTarget {
		t.Errorf("expected pushTarget to be forwarded, got %+v", local.gotUpstreamPushTarget)
	}
}

// ── TASK-BE-EVM-015: dispatchExecutorForRepo threads
// domain.RepoInfo.HiddenTargetID into ctx (WithHiddenTargetID) alongside
// WithDevServerID, only on the relay branch — the actual wiring point
// audited in this task ("Nơi RepoPath được resolve cho 1 repo/workspace
// ephemeral-VM-backed"). RelayExecutor.relay's own behavior (routing to a
// "ViaHiddenTarget" method name) is covered separately by
// grpcclient_test.go's TestGitDispatch_HiddenTargetID_RoutesToAgentHiddenTargetMethod. ──

func TestDispatchExecutorForRepo_HiddenTargetID_ThreadedIntoContext_WhenRelayed(t *testing.T) {
	reachability := &fakeDevServerReachability{reachable: true}
	local := &fakeGitExecutor{name: "local"}
	relay := &fakeGitExecutor{name: "relay"}
	repo := domain.RepoInfo{ID: "repo-1", URL: "/repo", DevServerID: "ds-1", HiddenTargetID: "runtime-1"}

	ctx, executor, repoPath, err := dispatchExecutorForRepo(context.Background(), reachability, local, relay, repo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if executor != relay {
		t.Fatal("expected the relay executor when reachable")
	}
	if repoPath != "/repo" {
		t.Errorf("expected repoPath=/repo, got %q", repoPath)
	}
	if devServerID, ok := DevServerIDFromContext(ctx); !ok || devServerID != "ds-1" {
		t.Errorf("expected devServerID=ds-1 in ctx, got %q (ok=%v)", devServerID, ok)
	}
	if hiddenTargetID, ok := HiddenTargetIDFromContext(ctx); !ok || hiddenTargetID != "runtime-1" {
		t.Errorf("expected hiddenTargetID=runtime-1 in ctx, got %q (ok=%v)", hiddenTargetID, ok)
	}
}

func TestDispatchExecutorForRepo_NoHiddenTargetID_UnchangedBehavior(t *testing.T) {
	reachability := &fakeDevServerReachability{reachable: true}
	local := &fakeGitExecutor{name: "local"}
	relay := &fakeGitExecutor{name: "relay"}
	// Regression guard: an ordinary dev-server-backed repo (the common
	// case, HiddenTargetID never set) must not gain a hiddenTargetID in
	// ctx just because DevServerID is set.
	repo := domain.RepoInfo{ID: "repo-1", URL: "/repo", DevServerID: "ds-1"}

	ctx, executor, _, err := dispatchExecutorForRepo(context.Background(), reachability, local, relay, repo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if executor != relay {
		t.Fatal("expected the relay executor when reachable")
	}
	if _, ok := HiddenTargetIDFromContext(ctx); ok {
		t.Error("expected no hiddenTargetID in ctx for an ordinary repo")
	}
}

func TestDispatchExecutorForRepo_LocalFallback_NeverSetsHiddenTargetID(t *testing.T) {
	reachability := &fakeDevServerReachability{reachable: false}
	local := &fakeGitExecutor{name: "local"}
	relay := &fakeGitExecutor{name: "relay"}
	repo := domain.RepoInfo{ID: "repo-1", URL: "/repo", DevServerID: "ds-1", HiddenTargetID: "runtime-1"}

	ctx, executor, _, err := dispatchExecutorForRepo(context.Background(), reachability, local, relay, repo)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if executor != local {
		t.Fatal("expected the local executor when the dev server is unreachable")
	}
	if _, ok := HiddenTargetIDFromContext(ctx); ok {
		t.Error("expected no hiddenTargetID in ctx when falling back to local execution")
	}
}
