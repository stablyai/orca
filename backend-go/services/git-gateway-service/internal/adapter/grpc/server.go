// Package grpc implements the generated gitgatewayv1.GitGatewayServiceServer
// interface by translating wire messages to/from usecase calls — no
// business logic here, per
// specs/backend-go/architecture/03-clean-architecture-guidelines.md's
// inbound-adapter contract.
package grpc

import (
	"context"
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/emptypb"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
	"github.com/stablyai/orca-go/services/git-gateway-service/internal/usecase"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
)

// Server implements gitgatewayv1.UnimplementedGitGatewayServiceServer.
type Server struct {
	gitgatewayv1.UnimplementedGitGatewayServiceServer

	getStatus             *usecase.GetStatus
	getDiff               *usecase.GetDiff
	commit                *usecase.Commit
	push                  *usecase.Push
	pull                  *usecase.Pull
	generateCommitMessage *usecase.GenerateCommitMessage

	stage   *usecase.Stage
	unstage *usecase.Unstage

	history         *usecase.History
	checkIgnored    *usecase.CheckIgnored
	forkSync        *usecase.ForkSync
	upstreamStatus  *usecase.UpstreamStatus
	commitCompare   *usecase.CommitCompare
	branchCompare   *usecase.BranchCompare
	commitDiff      *usecase.CommitDiff
	branchDiff      *usecase.BranchDiff
	submoduleStatus *usecase.SubmoduleStatus

	remoteCommitURL *usecase.RemoteCommitURL
	remoteFileURL   *usecase.RemoteFileURL
	getRemoteURL    *usecase.GetRemoteURL
	fetch           *usecase.Fetch

	generatePullRequestFields   *usecase.GeneratePullRequestFields
	discoverCommitMessageModels *usecase.DiscoverCommitMessageModels

	readFile              *usecase.ReadFileUseCase
	readFileChunk         *usecase.ReadFileChunkUseCase
	readFilePreview       *usecase.ReadFilePreviewUseCase
	readDir               *usecase.ReadDirUseCase
	writeFile             *usecase.WriteFileUseCase
	writeFileChunk        *usecase.WriteFileChunkUseCase
	createDir             *usecase.CreateDirUseCase
	createFile            *usecase.CreateFileUseCase
	deleteFile            *usecase.DeleteFileUseCase
	statFile              *usecase.StatFileUseCase
	searchFiles           *usecase.SearchFilesUseCase
	listAllFiles          *usecase.ListAllFilesUseCase
	listMarkdownDocuments *usecase.ListMarkdownDocumentsUseCase
	renameFile            *usecase.RenameFileUseCase
	copyFile              *usecase.CopyFileUseCase

	clone                  *usecase.Clone
	initRepo               *usecase.InitRepo
	baseRefDefault         *usecase.BaseRefDefault
	searchRefs             *usecase.SearchRefs
	checkHooks             *usecase.CheckHooks
	readEphemeralVmRecipes *usecase.ReadEphemeralVmRecipes
	readIssueCommand       *usecase.ReadIssueCommand
	writeIssueCommand      *usecase.WriteIssueCommand
	scanSetupScriptImports *usecase.ScanSetupScriptImports

	// New, SOL-031 (TASK-192/193/194):
	createWorktree     *usecase.CreateWorktree
	removeWorktree     *usecase.RemoveWorktree
	forceDeleteBranch  *usecase.ForceDeleteBranch
	detectWorktrees    *usecase.DetectWorktrees
	prefetchCreateBase *usecase.PrefetchCreateBase
	resolvePrBase      *usecase.ResolvePrBase
	resolveMrBase      *usecase.ResolveMrBase

	// Group A — branch/ref operations (TASK-207)
	checkout          *usecase.Checkout
	listLocalBranches *usecase.ListLocalBranches
	fastForward       *usecase.FastForward
	rebaseFromBase    *usecase.RebaseFromBase
	abortRebase       *usecase.AbortRebase
	abortMerge        *usecase.AbortMerge
	conflictOperation *usecase.ConflictOperation
	resolveConflict   *usecase.ResolveConflict
	discard           *usecase.Discard
	bulkDiscard       *usecase.BulkDiscard
}

// New wires every usecase this server dispatches to. Parameter order
// mirrors this struct's field order above (git.* core, staging,
// history/compare, remote, AI-assist, files.*, repo.*, then worktree.*).
func New(
	getStatus *usecase.GetStatus,
	getDiff *usecase.GetDiff,
	commit *usecase.Commit,
	push *usecase.Push,
	pull *usecase.Pull,
	generateCommitMessage *usecase.GenerateCommitMessage,
	stage *usecase.Stage,
	unstage *usecase.Unstage,
	history *usecase.History,
	checkIgnored *usecase.CheckIgnored,
	forkSync *usecase.ForkSync,
	upstreamStatus *usecase.UpstreamStatus,
	commitCompare *usecase.CommitCompare,
	branchCompare *usecase.BranchCompare,
	commitDiff *usecase.CommitDiff,
	branchDiff *usecase.BranchDiff,
	submoduleStatus *usecase.SubmoduleStatus,
	remoteCommitURL *usecase.RemoteCommitURL,
	remoteFileURL *usecase.RemoteFileURL,
	getRemoteURL *usecase.GetRemoteURL,
	fetch *usecase.Fetch,
	generatePullRequestFields *usecase.GeneratePullRequestFields,
	discoverCommitMessageModels *usecase.DiscoverCommitMessageModels,
	readFile *usecase.ReadFileUseCase,
	readFileChunk *usecase.ReadFileChunkUseCase,
	readFilePreview *usecase.ReadFilePreviewUseCase,
	readDir *usecase.ReadDirUseCase,
	writeFile *usecase.WriteFileUseCase,
	writeFileChunk *usecase.WriteFileChunkUseCase,
	createDir *usecase.CreateDirUseCase,
	createFile *usecase.CreateFileUseCase,
	deleteFile *usecase.DeleteFileUseCase,
	statFile *usecase.StatFileUseCase,
	searchFiles *usecase.SearchFilesUseCase,
	listAllFiles *usecase.ListAllFilesUseCase,
	listMarkdownDocuments *usecase.ListMarkdownDocumentsUseCase,
	renameFile *usecase.RenameFileUseCase,
	copyFile *usecase.CopyFileUseCase,
	clone *usecase.Clone,
	initRepo *usecase.InitRepo,
	baseRefDefault *usecase.BaseRefDefault,
	searchRefs *usecase.SearchRefs,
	checkHooks *usecase.CheckHooks,
	readIssueCommand *usecase.ReadIssueCommand,
	writeIssueCommand *usecase.WriteIssueCommand,
	scanSetupScriptImports *usecase.ScanSetupScriptImports,
	createWorktree *usecase.CreateWorktree,
	removeWorktree *usecase.RemoveWorktree,
	forceDeleteBranch *usecase.ForceDeleteBranch,
	detectWorktrees *usecase.DetectWorktrees,
	prefetchCreateBase *usecase.PrefetchCreateBase,
	resolvePrBase *usecase.ResolvePrBase,
	resolveMrBase *usecase.ResolveMrBase,
	checkout *usecase.Checkout,
	listLocalBranches *usecase.ListLocalBranches,
	fastForward *usecase.FastForward,
	rebaseFromBase *usecase.RebaseFromBase,
	abortRebase *usecase.AbortRebase,
	abortMerge *usecase.AbortMerge,
	conflictOperation *usecase.ConflictOperation,
	resolveConflict *usecase.ResolveConflict,
	discard *usecase.Discard,
	bulkDiscard *usecase.BulkDiscard,
	readEphemeralVmRecipes *usecase.ReadEphemeralVmRecipes,
) *Server {
	return &Server{
		getStatus:                   getStatus,
		getDiff:                     getDiff,
		commit:                      commit,
		push:                        push,
		pull:                        pull,
		generateCommitMessage:       generateCommitMessage,
		stage:                       stage,
		unstage:                     unstage,
		history:                     history,
		checkIgnored:                checkIgnored,
		forkSync:                    forkSync,
		upstreamStatus:              upstreamStatus,
		commitCompare:               commitCompare,
		branchCompare:               branchCompare,
		commitDiff:                  commitDiff,
		branchDiff:                  branchDiff,
		submoduleStatus:             submoduleStatus,
		remoteCommitURL:             remoteCommitURL,
		remoteFileURL:               remoteFileURL,
		getRemoteURL:                getRemoteURL,
		fetch:                       fetch,
		generatePullRequestFields:   generatePullRequestFields,
		discoverCommitMessageModels: discoverCommitMessageModels,
		readFile:                    readFile,
		readFileChunk:               readFileChunk,
		readFilePreview:             readFilePreview,
		readDir:                     readDir,
		writeFile:                   writeFile,
		writeFileChunk:              writeFileChunk,
		createDir:                   createDir,
		createFile:                  createFile,
		deleteFile:                  deleteFile,
		statFile:                    statFile,
		searchFiles:                 searchFiles,
		listAllFiles:                listAllFiles,
		listMarkdownDocuments:       listMarkdownDocuments,
		renameFile:                  renameFile,
		copyFile:                    copyFile,

		clone:                  clone,
		initRepo:               initRepo,
		baseRefDefault:         baseRefDefault,
		searchRefs:             searchRefs,
		checkHooks:             checkHooks,
		readIssueCommand:       readIssueCommand,
		writeIssueCommand:      writeIssueCommand,
		scanSetupScriptImports: scanSetupScriptImports,

		createWorktree:     createWorktree,
		removeWorktree:     removeWorktree,
		forceDeleteBranch:  forceDeleteBranch,
		detectWorktrees:    detectWorktrees,
		prefetchCreateBase: prefetchCreateBase,
		resolvePrBase:      resolvePrBase,
		resolveMrBase:      resolveMrBase,

		checkout:          checkout,
		listLocalBranches: listLocalBranches,
		fastForward:       fastForward,
		rebaseFromBase:    rebaseFromBase,
		abortRebase:       abortRebase,
		abortMerge:        abortMerge,
		conflictOperation: conflictOperation,
		resolveConflict:   resolveConflict,
		discard:           discard,
		bulkDiscard:       bulkDiscard,

		readEphemeralVmRecipes: readEphemeralVmRecipes,
	}
}

func (s *Server) GetStatus(ctx context.Context, req *gitgatewayv1.GetStatusRequest) (*gitgatewayv1.GetStatusResponse, error) {
	result, err := s.getStatus.Execute(ctx, usecase.GetStatusInput{WorktreeID: req.GetWorktreeId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.GetStatusResponse{
		Branch: result.Branch,
		Files:  toProtoFileStatuses(result.Files),
	}, nil
}

func (s *Server) GetDiff(ctx context.Context, req *gitgatewayv1.GetDiffRequest) (*gitgatewayv1.GetDiffResponse, error) {
	result, err := s.getDiff.Execute(ctx, usecase.GetDiffInput{
		WorktreeID: req.GetWorktreeId(), FilePath: req.GetFilePath(), Staged: req.GetStaged(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.GetDiffResponse{UnifiedDiff: result.UnifiedDiff}, nil
}

func (s *Server) Commit(ctx context.Context, req *gitgatewayv1.CommitRequest) (*gitgatewayv1.CommitResponse, error) {
	result, err := s.commit.Execute(ctx, usecase.CommitInput{
		WorktreeID: req.GetWorktreeId(),
		Message:    req.GetMessage(),
		Paths:      req.GetPaths(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CommitResponse{CommitSha: result.CommitSHA}, nil
}

func (s *Server) Push(ctx context.Context, req *gitgatewayv1.PushRequest) (*gitgatewayv1.PushResponse, error) {
	result, err := s.push.Execute(ctx, usecase.PushInput{
		WorktreeID: req.GetWorktreeId(),
		Remote:     req.GetRemote(),
		Branch:     req.GetBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.PushResponse{Success: result.Success}, nil
}

func (s *Server) Pull(ctx context.Context, req *gitgatewayv1.PullRequest) (*gitgatewayv1.PullResponse, error) {
	result, err := s.pull.Execute(ctx, usecase.PullInput{WorktreeID: req.GetWorktreeId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.PullResponse{Success: result.Success, HadConflicts: result.HadConflicts}, nil
}

// GenerateCommitMessage relays the worktree's staged diff to the Dev Server
// Agent's ai.complete (per git-gateway-service.md §3.1) via
// usecase.GenerateCommitMessage. A worktree with no relay connection maps
// to codes.FailedPrecondition through the normal apperrors.ToGRPCStatus
// path — no special-casing needed here now that the usecase always returns
// a typed AppError rather than a permanent stub sentinel.
func (s *Server) GenerateCommitMessage(ctx context.Context, req *gitgatewayv1.GenerateCommitMessageRequest) (*gitgatewayv1.GenerateCommitMessageResponse, error) {
	message, err := s.generateCommitMessage.Execute(ctx, usecase.GenerateCommitMessageInput{WorktreeID: req.GetWorktreeId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.GenerateCommitMessageResponse{Message: message}, nil
}

// ── Group B — staging (TASK-208) ──────────────────────────────────────────

func (s *Server) Stage(ctx context.Context, req *gitgatewayv1.StageRequest) (*gitgatewayv1.StageResponse, error) {
	result, err := s.stage.Execute(ctx, usecase.StageInput{WorktreeID: req.GetWorktreeId(), Paths: req.GetPaths()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.StageResponse{Success: result.Success}, nil
}

func (s *Server) Unstage(ctx context.Context, req *gitgatewayv1.UnstageRequest) (*gitgatewayv1.UnstageResponse, error) {
	result, err := s.unstage.Execute(ctx, usecase.UnstageInput{WorktreeID: req.GetWorktreeId(), Paths: req.GetPaths()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.UnstageResponse{Success: result.Success}, nil
}

// ── Group C — history/compare (TASK-209, shippable-now subset) ───────────

func (s *Server) History(ctx context.Context, req *gitgatewayv1.HistoryRequest) (*gitgatewayv1.HistoryResponse, error) {
	result, err := s.history.Execute(ctx, usecase.HistoryInput{
		WorktreeID: req.GetWorktreeId(), BaseRef: req.GetBaseRef(), Limit: int(req.GetLimit()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.HistoryResponse{Commits: toProtoCommitRefs(result.Commits)}, nil
}

func (s *Server) CheckIgnored(ctx context.Context, req *gitgatewayv1.CheckIgnoredRequest) (*gitgatewayv1.CheckIgnoredResponse, error) {
	ignored, err := s.checkIgnored.Execute(ctx, usecase.CheckIgnoredInput{WorktreeID: req.GetWorktreeId(), Paths: req.GetPaths()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CheckIgnoredResponse{IgnoredPaths: ignored}, nil
}

func (s *Server) ForkSync(ctx context.Context, req *gitgatewayv1.ForkSyncRequest) (*gitgatewayv1.ForkSyncResponse, error) {
	result, err := s.forkSync.Execute(ctx, usecase.ForkSyncInput{
		WorktreeID: req.GetWorktreeId(), ExpectedUpstream: req.GetExpectedUpstream(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ForkSyncResponse{Ahead: int32(result.Ahead), Behind: int32(result.Behind), Diverged: result.Diverged}, nil
}

// ── repo.* (TASK-156) ─────────────────────────────────────────────────────

func (s *Server) Clone(ctx context.Context, req *gitgatewayv1.CloneRequest) (*gitgatewayv1.CloneResponse, error) {
	result, err := s.clone.Execute(ctx, usecase.CloneInput{
		DevServerID: req.GetDevServerId(), URL: req.GetUrl(), DestPath: req.GetDestPath(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CloneResponse{WorktreePath: result.WorktreePath, DefaultBranch: result.DefaultBranch}, nil
}

func (s *Server) InitRepo(ctx context.Context, req *gitgatewayv1.InitRepoRequest) (*gitgatewayv1.InitRepoResponse, error) {
	result, err := s.initRepo.Execute(ctx, usecase.InitRepoInput{
		DevServerID: req.GetDevServerId(), DestPath: req.GetDestPath(), DefaultBranch: req.GetDefaultBranch(),
		RemoteName: req.GetRemoteName(), RemoteURL: req.GetRemoteUrl(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.InitRepoResponse{Path: result.Path, DefaultBranch: result.DefaultBranch, RemoteAdded: result.RemoteAdded}, nil
}

func (s *Server) UpstreamStatus(ctx context.Context, req *gitgatewayv1.UpstreamStatusRequest) (*gitgatewayv1.UpstreamStatusResponse, error) {
	result, err := s.upstreamStatus.Execute(ctx, usecase.UpstreamStatusInput{
		WorktreeID: req.GetWorktreeId(), PushTarget: fromProtoPushTarget(req.GetPushTarget()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.UpstreamStatusResponse{HasUpstream: result.HasUpstream, Ahead: int32(result.Ahead), Behind: int32(result.Behind)}, nil
}

// CommitCompare/BranchCompare/CommitDiff/BranchDiff/SubmoduleStatus below
// implement TASK-209's real shape redesign (see each usecase/proto message's
// own doc comment for citations) — no longer BLOCKED.

func (s *Server) CommitCompare(ctx context.Context, req *gitgatewayv1.CommitCompareRequest) (*gitgatewayv1.CommitCompareResponse, error) {
	result, err := s.commitCompare.Execute(ctx, usecase.CommitCompareInput{
		WorktreeID: req.GetWorktreeId(), CommitID: req.GetCommitId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CommitCompareResponse{
		CommitOid: result.CommitOID, ParentOid: result.ParentOID, CompareRef: result.CompareRef,
		BaseRef: result.BaseRef, ChangedFiles: int32(result.ChangedFiles), Status: result.Status,
		ErrorMessage: result.ErrorMessage, Entries: toProtoChangeEntries(result.Entries),
	}, nil
}

func (s *Server) BranchCompare(ctx context.Context, req *gitgatewayv1.BranchCompareRequest) (*gitgatewayv1.BranchCompareResponse, error) {
	result, err := s.branchCompare.Execute(ctx, usecase.BranchCompareInput{
		WorktreeID: req.GetWorktreeId(), BaseRef: req.GetBaseRef(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.BranchCompareResponse{
		BaseRef: result.BaseRef, BaseOid: result.BaseOID, CompareRef: result.CompareRef,
		HeadOid: result.HeadOID, MergeBase: result.MergeBase, ChangedFiles: int32(result.ChangedFiles),
		CommitsAhead: int32(result.CommitsAhead), Status: result.Status, ErrorMessage: result.ErrorMessage,
		Entries: toProtoChangeEntries(result.Entries),
	}, nil
}

func (s *Server) CommitDiff(ctx context.Context, req *gitgatewayv1.CommitDiffRequest) (*gitgatewayv1.FileDiffResponse, error) {
	result, err := s.commitDiff.Execute(ctx, usecase.CommitDiffInput{
		WorktreeID: req.GetWorktreeId(), CommitOID: req.GetCommitOid(), ParentOID: req.GetParentOid(),
		FilePath: req.GetFilePath(), OldPath: req.GetOldPath(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoFileDiff(result), nil
}

func (s *Server) BranchDiff(ctx context.Context, req *gitgatewayv1.BranchDiffRequest) (*gitgatewayv1.FileDiffResponse, error) {
	result, err := s.branchDiff.Execute(ctx, usecase.BranchDiffInput{
		WorktreeID: req.GetWorktreeId(), BaseRef: req.GetBaseRef(), FilePath: req.GetFilePath(), OldPath: req.GetOldPath(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return toProtoFileDiff(result), nil
}

func (s *Server) SubmoduleStatus(ctx context.Context, req *gitgatewayv1.SubmoduleStatusRequest) (*gitgatewayv1.GetStatusResponse, error) {
	result, err := s.submoduleStatus.Execute(ctx, usecase.SubmoduleStatusInput{
		WorktreeID: req.GetWorktreeId(), SubmodulePath: req.GetSubmodulePath(), Area: req.GetArea(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.GetStatusResponse{Branch: result.Branch, Files: toProtoFileStatuses(result.Files)}, nil
}

func (s *Server) Fetch(ctx context.Context, req *gitgatewayv1.FetchRequest) (*gitgatewayv1.FetchResponse, error) {
	result, err := s.fetch.Execute(ctx, usecase.FetchInput{
		WorktreeID: req.GetWorktreeId(), PushTarget: fromProtoPushTarget(req.GetPushTarget()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.FetchResponse{Success: result.Success}, nil
}

// ── Group D — remote (TASK-210, shippable-now subset) ────────────────────

func (s *Server) RemoteCommitUrl(ctx context.Context, req *gitgatewayv1.RemoteCommitUrlRequest) (*gitgatewayv1.RemoteUrlResponse, error) {
	url, err := s.remoteCommitURL.Execute(ctx, usecase.RemoteCommitURLInput{
		WorktreeID: req.GetWorktreeId(), SHA: req.GetSha(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.RemoteUrlResponse{Url: url}, nil
}

func (s *Server) RemoteFileUrl(ctx context.Context, req *gitgatewayv1.RemoteFileUrlRequest) (*gitgatewayv1.RemoteUrlResponse, error) {
	url, err := s.remoteFileURL.Execute(ctx, usecase.RemoteFileURLInput{
		WorktreeID: req.GetWorktreeId(), Path: req.GetPath(), Ref: req.GetRef(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.RemoteUrlResponse{Url: url}, nil
}

// ── Group E — AI-assist (TASK-211) ────────────────────────────────────────

func (s *Server) GeneratePullRequestFields(ctx context.Context, req *gitgatewayv1.GeneratePullRequestFieldsRequest) (*gitgatewayv1.GeneratePullRequestFieldsResponse, error) {
	fields, err := s.generatePullRequestFields.Execute(ctx, usecase.GeneratePullRequestFieldsInput{
		WorktreeID: req.GetWorktreeId(), BaseBranch: req.GetBaseBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.GeneratePullRequestFieldsResponse{Title: fields.Title, Description: fields.Description}, nil
}

func (s *Server) DiscoverCommitMessageModels(ctx context.Context, req *gitgatewayv1.DiscoverCommitMessageModelsRequest) (*gitgatewayv1.DiscoverCommitMessageModelsResponse, error) {
	models, err := s.discoverCommitMessageModels.Execute(ctx, usecase.DiscoverCommitMessageModelsInput{
		TenantID: req.GetTenantId(), UserID: req.GetUserId(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*gitgatewayv1.ModelInfo, 0, len(models))
	for _, m := range models {
		out = append(out, &gitgatewayv1.ModelInfo{ProviderType: m.ProviderType, AccountId: m.AccountID, Status: m.Status})
	}
	return &gitgatewayv1.DiscoverCommitMessageModelsResponse{Models: out}, nil
}

// ── File I/O (TASK-049/TASK-056) ──────────────────────────────────────────

func (s *Server) ReadFile(ctx context.Context, req *gitgatewayv1.ReadFileRequest) (*gitgatewayv1.ReadFileResponse, error) {
	content, err := s.readFile.Execute(ctx, req.GetWorktreeId(), req.GetPath())
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.ReadFileResponse{Content: content, Encoding: "utf8"}, nil
}

func (s *Server) ReadFileChunk(ctx context.Context, req *gitgatewayv1.ReadFileChunkRequest) (*gitgatewayv1.ReadFileChunkResponse, error) {
	content, err := s.readFileChunk.Execute(ctx, req.GetWorktreeId(), req.GetPath(), req.GetOffsetBytes(), req.GetLengthBytes())
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.ReadFileChunkResponse{Content: content, Eof: int64(len(content)) < req.GetLengthBytes()}, nil
}

func (s *Server) ReadFilePreview(ctx context.Context, req *gitgatewayv1.ReadFilePreviewRequest) (*gitgatewayv1.ReadFilePreviewResponse, error) {
	content, truncated, err := s.readFilePreview.Execute(ctx, req.GetWorktreeId(), req.GetPath(), req.GetMaxBytes())
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.ReadFilePreviewResponse{Content: content, Truncated: truncated}, nil
}

func (s *Server) ReadDir(ctx context.Context, req *gitgatewayv1.ReadDirRequest) (*gitgatewayv1.ReadDirResponse, error) {
	entries, err := s.readDir.Execute(ctx, req.GetWorktreeId(), req.GetPath())
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	out := make([]*gitgatewayv1.DirEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, &gitgatewayv1.DirEntry{Name: e.Name, IsDirectory: e.IsDirectory})
	}
	return &gitgatewayv1.ReadDirResponse{Entries: out}, nil
}

func (s *Server) WriteFile(ctx context.Context, req *gitgatewayv1.WriteFileRequest) (*gitgatewayv1.WriteFileResponse, error) {
	n, err := s.writeFile.Execute(ctx, req.GetWorktreeId(), req.GetPath(), req.GetContent(), req.GetCreateParents())
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.WriteFileResponse{BytesWritten: n}, nil
}

func (s *Server) WriteFileChunk(ctx context.Context, req *gitgatewayv1.WriteFileChunkRequest) (*gitgatewayv1.WriteFileChunkResponse, error) {
	n, err := s.writeFileChunk.Execute(ctx, req.GetWorktreeId(), req.GetPath(), req.GetOffsetBytes(), req.GetContent(), req.GetIsFinal())
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.WriteFileChunkResponse{BytesWritten: n}, nil
}

func (s *Server) CreateDir(ctx context.Context, req *gitgatewayv1.CreateDirRequest) (*gitgatewayv1.CreateDirResponse, error) {
	if err := s.createDir.Execute(ctx, req.GetWorktreeId(), req.GetPath(), req.GetRecursive(), req.GetNoClobber()); err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.CreateDirResponse{}, nil
}

func (s *Server) CreateFile(ctx context.Context, req *gitgatewayv1.CreateFileRequest) (*gitgatewayv1.CreateFileResponse, error) {
	if err := s.createFile.Execute(ctx, req.GetWorktreeId(), req.GetPath()); err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.CreateFileResponse{}, nil
}

func (s *Server) DeleteFile(ctx context.Context, req *gitgatewayv1.DeleteFileRequest) (*emptypb.Empty, error) {
	if err := s.deleteFile.Execute(ctx, req.GetWorktreeId(), req.GetPath(), req.GetRecursive()); err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) StatFile(ctx context.Context, req *gitgatewayv1.StatFileRequest) (*gitgatewayv1.StatFileResponse, error) {
	result, err := s.statFile.Execute(ctx, req.GetWorktreeId(), req.GetPath())
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.StatFileResponse{
		Exists:           result.Exists,
		IsDirectory:      result.IsDirectory,
		SizeBytes:        result.SizeBytes,
		ModifiedAtUnixMs: result.ModifiedAtUnixMs,
	}, nil
}

func (s *Server) SearchFiles(ctx context.Context, req *gitgatewayv1.SearchFilesRequest) (*gitgatewayv1.SearchFilesResponse, error) {
	matches, err := s.searchFiles.Execute(ctx, req.GetWorktreeId(), domain.SearchOptions{
		Pattern: req.GetPattern(), IsRegex: req.GetIsRegex(), PathGlob: req.GetPathGlob(), MaxResults: int(req.GetMaxResults()),
	})
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	out := make([]*gitgatewayv1.SearchMatch, 0, len(matches))
	for _, m := range matches {
		out = append(out, &gitgatewayv1.SearchMatch{Path: m.Path, Line: int32(m.Line), LineText: m.LineText})
	}
	return &gitgatewayv1.SearchFilesResponse{Matches: out}, nil
}

func (s *Server) ListAllFiles(ctx context.Context, req *gitgatewayv1.ListAllFilesRequest) (*gitgatewayv1.ListAllFilesResponse, error) {
	paths, err := s.listAllFiles.Execute(ctx, req.GetWorktreeId(), req.GetPathGlob(), int(req.GetMaxResults()))
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.ListAllFilesResponse{Paths: paths}, nil
}

func (s *Server) ListMarkdownDocuments(ctx context.Context, req *gitgatewayv1.ListMarkdownDocumentsRequest) (*gitgatewayv1.ListMarkdownDocumentsResponse, error) {
	paths, err := s.listMarkdownDocuments.Execute(ctx, req.GetWorktreeId(), int(req.GetMaxResults()))
	if err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.ListMarkdownDocumentsResponse{Paths: paths}, nil
}

func (s *Server) RenameFile(ctx context.Context, req *gitgatewayv1.RenameFileRequest) (*gitgatewayv1.RenameFileResponse, error) {
	if err := s.renameFile.Execute(ctx, req.GetWorktreeId(), req.GetFromPath(), req.GetToPath()); err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.RenameFileResponse{}, nil
}

func (s *Server) CopyFile(ctx context.Context, req *gitgatewayv1.CopyFileRequest) (*gitgatewayv1.CopyFileResponse, error) {
	if err := s.copyFile.Execute(ctx, req.GetWorktreeId(), req.GetFromPath(), req.GetToPath()); err != nil {
		return nil, toFileGRPCStatus(err)
	}
	return &gitgatewayv1.CopyFileResponse{}, nil
}

func (s *Server) BaseRefDefault(ctx context.Context, req *gitgatewayv1.BaseRefDefaultRequest) (*gitgatewayv1.BaseRefDefaultResponse, error) {
	ref, err := s.baseRefDefault.Execute(ctx, usecase.BaseRefDefaultInput{RepoID: req.GetRepoId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.BaseRefDefaultResponse{Ref: ref}, nil
}

func (s *Server) GetRemoteUrl(ctx context.Context, req *gitgatewayv1.GetRemoteUrlRequest) (*gitgatewayv1.GetRemoteUrlResponse, error) {
	url, err := s.getRemoteURL.Execute(ctx, usecase.GetRemoteURLInput{RepoID: req.GetRepoId(), RemoteName: req.GetRemoteName()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.GetRemoteUrlResponse{Url: url}, nil
}

func (s *Server) SearchRefs(ctx context.Context, req *gitgatewayv1.SearchRefsRequest) (*gitgatewayv1.SearchRefsResponse, error) {
	refs, err := s.searchRefs.Execute(ctx, usecase.SearchRefsInput{RepoID: req.GetRepoId(), Query: req.GetQuery()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.SearchRefsResponse{Refs: refs}, nil
}

func (s *Server) CheckHooks(ctx context.Context, req *gitgatewayv1.CheckHooksRequest) (*gitgatewayv1.CheckHooksResponse, error) {
	result, err := s.checkHooks.Execute(ctx, usecase.CheckHooksInput{RepoID: req.GetRepoId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CheckHooksResponse{InstalledHooks: result.InstalledHooks, OrcaHooksCurrent: result.OrcaHooksCurrent}, nil
}

func (s *Server) ReadEphemeralVmRecipes(ctx context.Context, req *gitgatewayv1.ReadEphemeralVmRecipesRequest) (*gitgatewayv1.ReadEphemeralVmRecipesResponse, error) {
	result, err := s.readEphemeralVmRecipes.Execute(ctx, usecase.ReadEphemeralVmRecipesInput{RepoID: req.GetRepoId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	recipes := make([]*gitgatewayv1.EphemeralVmRecipe, 0, len(result.Recipes))
	for _, r := range result.Recipes {
		recipes = append(recipes, &gitgatewayv1.EphemeralVmRecipe{
			Id: r.ID, Name: r.Name, Description: r.Description,
			Create: r.Create, Suspend: r.Suspend, Resume: r.Resume,
			Destroy: r.Destroy, DestroyDisabled: r.DestroyDisabled,
		})
	}
	return &gitgatewayv1.ReadEphemeralVmRecipesResponse{
		RepoPath: result.RepoPath, Recipes: recipes, Diagnostics: result.Diagnostics,
	}, nil
}

func (s *Server) ReadIssueCommand(ctx context.Context, req *gitgatewayv1.ReadIssueCommandRequest) (*gitgatewayv1.ReadIssueCommandResponse, error) {
	result, err := s.readIssueCommand.Execute(ctx, usecase.ReadIssueCommandInput{RepoID: req.GetRepoId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ReadIssueCommandResponse{Content: result.Content, Exists: result.Exists}, nil
}

func (s *Server) WriteIssueCommand(ctx context.Context, req *gitgatewayv1.WriteIssueCommandRequest) (*emptypb.Empty, error) {
	err := s.writeIssueCommand.Execute(ctx, usecase.WriteIssueCommandInput{RepoID: req.GetRepoId(), Content: req.GetContent()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) ScanSetupScriptImports(ctx context.Context, req *gitgatewayv1.ScanSetupScriptImportsRequest) (*gitgatewayv1.ScanSetupScriptImportsResponse, error) {
	paths, err := s.scanSetupScriptImports.Execute(ctx, usecase.ScanSetupScriptImportsInput{RepoID: req.GetRepoId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ScanSetupScriptImportsResponse{ImportedPaths: paths}, nil
}

// ── worktree.* (SOL-031, TASK-192/193/194) ─────────────────────────────────

func (s *Server) CreateWorktree(ctx context.Context, req *gitgatewayv1.CreateWorktreeRequest) (*gitgatewayv1.CreateWorktreeResponse, error) {
	result, err := s.createWorktree.Execute(ctx, usecase.CreateWorktreeInput{
		ProjectID: req.GetProjectId(), RepoID: req.GetRepoId(), Branch: req.GetBranch(), BaseRef: req.GetBaseRef(),
		Lineage: domain.WorktreeLineageCapture{
			ParentWorktreeID:        req.GetParentWorktreeId(),
			Origin:                  req.GetOrigin(),
			CaptureSource:           req.GetCaptureSource(),
			TaskID:                  req.GetTaskId(),
			OrchestrationRunID:      req.GetOrchestrationRunId(),
			CoordinatorHandle:       req.GetCoordinatorHandle(),
			CreatedByTerminalHandle: req.GetCreatedByTerminalHandle(),
		},
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CreateWorktreeResponse{WorktreeId: result.WorktreeID, Path: result.Path, HeadSha: result.HeadSHA}, nil
}

func (s *Server) RemoveWorktree(ctx context.Context, req *gitgatewayv1.RemoveWorktreeRequest) (*emptypb.Empty, error) {
	if err := s.removeWorktree.Execute(ctx, req.GetWorktreeId(), req.GetForce()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) ForceDeleteBranch(ctx context.Context, req *gitgatewayv1.ForceDeleteBranchRequest) (*emptypb.Empty, error) {
	if err := s.forceDeleteBranch.Execute(ctx, req.GetWorktreeId(), req.GetBranch()); err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &emptypb.Empty{}, nil
}

func (s *Server) DetectWorktrees(ctx context.Context, req *gitgatewayv1.DetectWorktreesRequest) (*gitgatewayv1.DetectWorktreesResponse, error) {
	infos, err := s.detectWorktrees.Execute(ctx, req.GetRepoId())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	out := make([]*gitgatewayv1.DetectedWorktreeGitInfo, 0, len(infos))
	for _, info := range infos {
		out = append(out, &gitgatewayv1.DetectedWorktreeGitInfo{Path: info.Path, Head: info.Head, Branch: info.Branch})
	}
	return &gitgatewayv1.DetectWorktreesResponse{OnDiskWorktrees: out}, nil
}

func (s *Server) PrefetchCreateBase(ctx context.Context, req *gitgatewayv1.PrefetchCreateBaseRequest) (*gitgatewayv1.PrefetchCreateBaseResponse, error) {
	sha, err := s.prefetchCreateBase.Execute(ctx, req.GetRepoId(), req.GetBaseRef())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.PrefetchCreateBaseResponse{ResolvedSha: sha}, nil
}

func (s *Server) ResolvePrBase(ctx context.Context, req *gitgatewayv1.ResolvePrBaseRequest) (*gitgatewayv1.ResolveBaseResponse, error) {
	resolved, err := s.resolvePrBase.Execute(ctx, req.GetRepoId(), req.GetPrNumber())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ResolveBaseResponse{BaseBranch: resolved.Branch, BaseSha: resolved.SHA}, nil
}

func (s *Server) ResolveMrBase(ctx context.Context, req *gitgatewayv1.ResolveMrBaseRequest) (*gitgatewayv1.ResolveBaseResponse, error) {
	resolved, err := s.resolveMrBase.Execute(ctx, req.GetRepoId(), req.GetMrNumber())
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ResolveBaseResponse{BaseBranch: resolved.Branch, BaseSha: resolved.SHA}, nil
}

// ── Group A — branch/ref operations (TASK-207) ─────────────────────────────

func (s *Server) Checkout(ctx context.Context, req *gitgatewayv1.CheckoutRequest) (*gitgatewayv1.CheckoutResponse, error) {
	result, err := s.checkout.Execute(ctx, usecase.CheckoutInput{
		WorktreeID: req.GetWorktreeId(), Branch: req.GetBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.CheckoutResponse{Success: result.Success, Branch: result.Branch}, nil
}

func (s *Server) ListLocalBranches(ctx context.Context, req *gitgatewayv1.ListLocalBranchesRequest) (*gitgatewayv1.ListLocalBranchesResponse, error) {
	branches, err := s.listLocalBranches.Execute(ctx, usecase.ListLocalBranchesInput{WorktreeID: req.GetWorktreeId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ListLocalBranchesResponse{Branches: toProtoBranches(branches)}, nil
}

func (s *Server) FastForward(ctx context.Context, req *gitgatewayv1.FastForwardRequest) (*gitgatewayv1.FastForwardResponse, error) {
	result, err := s.fastForward.Execute(ctx, usecase.FastForwardInput{
		WorktreeID: req.GetWorktreeId(), PushTarget: fromProtoPushTarget(req.GetPushTarget()),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.FastForwardResponse{Success: result.Success}, nil
}

func (s *Server) RebaseFromBase(ctx context.Context, req *gitgatewayv1.RebaseFromBaseRequest) (*gitgatewayv1.RebaseFromBaseResponse, error) {
	result, err := s.rebaseFromBase.Execute(ctx, usecase.RebaseFromBaseInput{
		WorktreeID: req.GetWorktreeId(), BaseRef: req.GetBaseBranch(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.RebaseFromBaseResponse{Success: result.Success, HadConflicts: result.HadConflicts}, nil
}

func (s *Server) AbortRebase(ctx context.Context, req *gitgatewayv1.AbortRebaseRequest) (*gitgatewayv1.AbortRebaseResponse, error) {
	result, err := s.abortRebase.Execute(ctx, usecase.AbortRebaseInput{WorktreeID: req.GetWorktreeId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.AbortRebaseResponse{Success: result.Success}, nil
}

func (s *Server) AbortMerge(ctx context.Context, req *gitgatewayv1.AbortMergeRequest) (*gitgatewayv1.AbortMergeResponse, error) {
	result, err := s.abortMerge.Execute(ctx, usecase.AbortMergeInput{WorktreeID: req.GetWorktreeId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.AbortMergeResponse{Success: result.Success}, nil
}

// ConflictOperation is a DETECTOR ONLY — see ConflictOperationRequest's
// proto doc comment. ResolveConflict below is the separate per-file
// resolve op.
func (s *Server) ConflictOperation(ctx context.Context, req *gitgatewayv1.ConflictOperationRequest) (*gitgatewayv1.ConflictOperationResponse, error) {
	operation, err := s.conflictOperation.Execute(ctx, usecase.ConflictOperationInput{WorktreeID: req.GetWorktreeId()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ConflictOperationResponse{Operation: operation}, nil
}

func (s *Server) ResolveConflict(ctx context.Context, req *gitgatewayv1.ResolveConflictRequest) (*gitgatewayv1.ResolveConflictResponse, error) {
	result, err := s.resolveConflict.Execute(ctx, usecase.ResolveConflictInput{
		WorktreeID: req.GetWorktreeId(), Path: req.GetPath(), Operation: req.GetOperation(),
	})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.ResolveConflictResponse{Success: result.Success}, nil
}

func (s *Server) Discard(ctx context.Context, req *gitgatewayv1.DiscardRequest) (*gitgatewayv1.DiscardResponse, error) {
	result, err := s.discard.Execute(ctx, usecase.DiscardInput{WorktreeID: req.GetWorktreeId(), Path: req.GetPath()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.DiscardResponse{Success: result.Success}, nil
}

func (s *Server) BulkDiscard(ctx context.Context, req *gitgatewayv1.BulkDiscardRequest) (*gitgatewayv1.BulkDiscardResponse, error) {
	result, err := s.bulkDiscard.Execute(ctx, usecase.BulkDiscardInput{WorktreeID: req.GetWorktreeId(), Paths: req.GetPaths()})
	if err != nil {
		return nil, apperrors.ToGRPCStatus(err)
	}
	return &gitgatewayv1.BulkDiscardResponse{Success: result.Success, FailedPaths: result.FailedPaths}, nil
}

func toProtoBranches(branches []domain.BranchInfo) []*gitgatewayv1.BranchInfo {
	out := make([]*gitgatewayv1.BranchInfo, 0, len(branches))
	for _, b := range branches {
		out = append(out, &gitgatewayv1.BranchInfo{
			Name: b.Name, Upstream: b.Upstream, Ahead: int32(b.Ahead), Behind: int32(b.Behind),
			IsCurrent: b.IsCurrent, IsRemote: b.IsRemote,
		})
	}
	return out
}

// fromProtoPushTarget translates the wire PushTargetInput to
// domain.PushTargetInput — nil in either direction means "no push target
// given", matching the real agent's undefined-pushTarget behavior (see
// PushTargetInput's proto doc comment).
func fromProtoPushTarget(pt *gitgatewayv1.PushTargetInput) *domain.PushTargetInput {
	if pt == nil {
		return nil
	}
	return &domain.PushTargetInput{
		RemoteName:    pt.GetRemoteName(),
		BranchName:    pt.GetBranchName(),
		RemoteURL:     pt.GetRemoteUrl(),
		RemoteCreated: pt.GetRemoteCreated(),
	}
}

func toProtoFileStatuses(files []domain.FileStatus) []*gitgatewayv1.FileStatus {
	out := make([]*gitgatewayv1.FileStatus, 0, len(files))
	for _, f := range files {
		out = append(out, &gitgatewayv1.FileStatus{Path: f.Path, State: string(f.State)})
	}
	return out
}

func toProtoCommitRefs(commits []domain.CommitRef) []*gitgatewayv1.CommitRef {
	out := make([]*gitgatewayv1.CommitRef, 0, len(commits))
	for _, c := range commits {
		out = append(out, &gitgatewayv1.CommitRef{
			Sha: c.SHA, Author: c.Author, Committer: c.Committer,
			Message: c.Message, Timestamp: c.Timestamp, ParentShas: c.ParentSHAs,
		})
	}
	return out
}

// toProtoChangeEntries translates domain.GitChangeEntry (CommitCompare/
// BranchCompare's real per-file shape) to its proto message-slice
// equivalent — mirrors toProtoFileStatuses.
func toProtoChangeEntries(entries []domain.GitChangeEntry) []*gitgatewayv1.GitChangeEntry {
	out := make([]*gitgatewayv1.GitChangeEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, &gitgatewayv1.GitChangeEntry{
			Path: e.Path, Status: e.Status, OldPath: e.OldPath, Added: int32(e.Added), Removed: int32(e.Removed),
		})
	}
	return out
}

// toProtoFileDiff translates domain.FileDiffResult (CommitDiff/BranchDiff's
// real per-file diff shape) to its proto message equivalent.
func toProtoFileDiff(result domain.FileDiffResult) *gitgatewayv1.FileDiffResponse {
	return &gitgatewayv1.FileDiffResponse{
		Kind: result.Kind, OriginalContent: result.OriginalContent, ModifiedContent: result.ModifiedContent,
		OriginalIsBinary: result.OriginalIsBinary, ModifiedIsBinary: result.ModifiedIsBinary,
	}
}

// toFileGRPCStatus maps file-I/O usecase errors to a gRPC status. The
// files.* usecases (TASK-052/TASK-055) return either an *apperrors.AppError
// (via the same convention as every other usecase in this service) or one
// of two bare sentinel errors for the "not supported over relay"/"chunked
// read over relay" known gaps (BUG-009) — those two are mapped to
// FailedPrecondition here rather than wrapped in apperrors.New at the
// usecase layer, since they're returned directly by
// ConnectionResolver-consuming usecases that don't otherwise build
// AppErrors (ReadFileChunkUseCase, RenameFileUseCase, CopyFileUseCase).
func toFileGRPCStatus(err error) error {
	if errors.Is(err, usecase.ErrFileOpNotSupportedOverRelay) || errors.Is(err, usecase.ErrChunkedReadNotSupportedRemote) {
		return status.Error(codes.FailedPrecondition, err.Error())
	}
	var ae *apperrors.AppError
	if errors.As(err, &ae) {
		return apperrors.ToGRPCStatus(err)
	}
	return status.Error(codes.Internal, err.Error())
}
