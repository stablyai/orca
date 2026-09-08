// New wscompat channel registrations for the git-gateway-service RPCs added
// by TASK-206/TASK-207/TASK-208/TASK-209(shippable subset)/TASK-210(shippable
// subset)/TASK-211/TASK-049..060. Kept in its own file rather than
// channels.go: other agents are wiring other namespaces in parallel in
// their own worktrees and will also want to add registrations to
// channels.go — editing that shared file directly across worktrees creates
// unmergeable conflicts. registerGitDeepChannels/registerFilesChannels are
// ready to be called from RegisterRealChannels once a separate integration
// pass merges every group's new channels_*.go file — see this repo's
// docs/execution-plan.md and this task's own final report for the exact
// one-line wiring still needed.
//
// git.status/git.diff already exist in channels.go's registerGitChannels;
// this file's git.diff registration below (with the filePath TASK-228
// added) is the correct, up-to-date one — when wired in, call
// registerGitDeepChannels AFTER registerGitChannels so this file's
// registration wins (Registry.Register simply overwrites the map entry).
package wscompat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	gitgatewayv1 "github.com/stablyai/orca-go/proto/gen/go/orca/gitgateway/v1"
	projectv1 "github.com/stablyai/orca-go/proto/gen/go/orca/project/v1"

	gatewaygrpc "github.com/stablyai/orca-go/services/api-gateway/internal/adapter/grpc"
	"github.com/stablyai/orca-go/services/api-gateway/internal/usecase"
)

// cancelGenerateArgs mirrors cancelRuntimeGenerateCommitMessage/
// cancelRuntimeGeneratePullRequestFields's exact wire shape
// (runtime-git-client.ts: {worktree: toRuntimeWorktreeSelector(...)}) —
// same field-name convention the generate calls' own genArgs/genPRFieldsArgs
// already use.
type cancelGenerateArgs struct {
	WorktreeID string `json:"worktreeId"`
}

// registerGitDeepChannels wires every git.* channel this scope's tasks
// (TASK-206/207/208/209/210/211/212/213) back with a real git-gateway-service
// RPC. TASK-207's Group A (branch/ref operations) is implemented and wired
// below — 4 of its 9 original methods (checkout/localBranches/fastForward/
// conflictOperation) use a redesigned request/response shape against the
// real agent contract rather than TASK-212's own stale pre-correction
// sketch; see TASK-207's own doc comments for citations, and this section's
// inline notes for exactly how each channel's args differ from that stale
// sketch. commitCompare/branchCompare/commitDiff/branchDiff/submoduleStatus/
// fetch were flagged BLOCKED in their own task files (TASK-209/210) — now
// implemented for real against the confirmed agent contract
// (specs/agent/api/agent-rpc-catalog-git-fs.md:49-55/143-147/155) and wired
// below; see gitgateway.proto's matching message doc comments for citations.
func registerGitDeepChannels(r *Registry, client gitgatewayv1.GitGatewayServiceClient) {
	// ── TASK-206: commit/push/pull/generateCommitMessage ────────────────

	r.Register("git.commit", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type commitArgs struct {
			WorktreeID string   `json:"worktreeId"`
			Message    string   `json:"message"`
			Paths      []string `json:"paths"`
		}
		in, err := decodeArg[commitArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Commit(ctx, &gitgatewayv1.CommitRequest{
			WorktreeId: in.WorktreeID, Message: in.Message, Paths: in.Paths,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.push", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type pushArgs struct {
			WorktreeID string `json:"worktreeId"`
			Remote     string `json:"remote"`
			Branch     string `json:"branch"`
		}
		in, err := decodeArg[pushArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Push(ctx, &gitgatewayv1.PushRequest{
			WorktreeId: in.WorktreeID, Remote: in.Remote, Branch: in.Branch,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.pull", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type pullArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[pullArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Pull(ctx, &gitgatewayv1.PullRequest{WorktreeId: in.WorktreeID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.generateCommitMessage", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type genArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[genArgs](args, 0)
		if err != nil {
			return nil, err
		}
		// genCtx is independently cancellable via
		// git.cancelGenerateCommitMessage (a second, independent WS
		// request/goroutine) — see git_generate_cancellation.go (TASK-031).
		// dispatchRPCTimeout (registry.go's 60s outer bound) still applies as
		// the upper bound; this WithCancel narrows further via explicit
		// cancel, it doesn't replace that deadline.
		genCtx, cancel := context.WithCancel(ctx)
		key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindCommitMessage}
		cleanup := gitGenerateCancels.start(key, cancel)
		defer cleanup()
		defer cancel() // release resources if genCtx's parent finishes normally, not via explicit cancel

		resp, err := client.GenerateCommitMessage(genCtx, &gitgatewayv1.GenerateCommitMessageRequest{WorktreeId: in.WorktreeID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.cancelGenerateCommitMessage", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[cancelGenerateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindCommitMessage}
		gitGenerateCancels.cancel(key) // return value ignored — "nothing in flight" is not an error, see cancel()'s doc comment
		return nil, nil
	})

	// ── TASK-228: git.diff, corrected to thread filePath through — this
	// registration supersedes channels.go's older git.diff (no filePath)
	// once both are wired in RegisterRealChannels, per this file's package
	// doc comment. ─────────────────────────────────────────────────────
	r.Register("git.diff", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type diffArgs struct {
			WorktreeID string `json:"worktreeId"`
			FilePath   string `json:"filePath"`
			Staged     bool   `json:"staged"`
		}
		in, err := decodeArg[diffArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.GetDiff(ctx, &gitgatewayv1.GetDiffRequest{
			WorktreeId: in.WorktreeID, FilePath: in.FilePath, Staged: in.Staged,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// ── TASK-207/TASK-212 (Group A — branch/ref operations). checkout/
	// localBranches/fastForward/conflictOperation's args below use
	// TASK-207's redesigned shape, NOT TASK-212's own stale pre-correction
	// sketch (dropped `create`, renamed `ref`->`branch` for checkout;
	// structured `pushTarget` instead of a bare `branch` string for
	// fastForward; `conflictOperation` is worktree-only now — a DETECTOR,
	// see the new `git.resolveConflict` channel below for the per-file
	// resolve op TASK-212's sketch conflated with it). rebaseFromBase/
	// abortRebase/abortMerge/discard/bulkDiscard match TASK-212's sketch
	// exactly (mechanical param rename only). ──────────────────────────

	r.Register("git.checkout", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type checkoutArgs struct {
			WorktreeID string `json:"worktreeId"`
			Branch     string `json:"branch"`
		}
		in, err := decodeArg[checkoutArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Checkout(ctx, &gitgatewayv1.CheckoutRequest{WorktreeId: in.WorktreeID, Branch: in.Branch})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.localBranches", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type localBranchesArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[localBranchesArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ListLocalBranches(ctx, &gitgatewayv1.ListLocalBranchesRequest{WorktreeId: in.WorktreeID})
		if err != nil {
			return nil, err
		}
		return resp.GetBranches(), nil
	})

	r.Register("git.fastForward", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type pushTargetArgs struct {
			RemoteName    string `json:"remoteName"`
			BranchName    string `json:"branchName"`
			RemoteURL     string `json:"remoteUrl"`
			RemoteCreated bool   `json:"remoteCreated"`
		}
		type fastForwardArgs struct {
			WorktreeID string          `json:"worktreeId"`
			PushTarget *pushTargetArgs `json:"pushTarget"`
		}
		in, err := decodeArg[fastForwardArgs](args, 0)
		if err != nil {
			return nil, err
		}
		req := &gitgatewayv1.FastForwardRequest{WorktreeId: in.WorktreeID}
		if in.PushTarget != nil {
			req.PushTarget = &gitgatewayv1.PushTargetInput{
				RemoteName: in.PushTarget.RemoteName, BranchName: in.PushTarget.BranchName,
				RemoteUrl: in.PushTarget.RemoteURL, RemoteCreated: in.PushTarget.RemoteCreated,
			}
		}
		resp, err := client.FastForward(ctx, req)
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.rebaseFromBase", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type rebaseArgs struct {
			WorktreeID string `json:"worktreeId"`
			BaseBranch string `json:"baseBranch"`
		}
		in, err := decodeArg[rebaseArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.RebaseFromBase(ctx, &gitgatewayv1.RebaseFromBaseRequest{WorktreeId: in.WorktreeID, BaseBranch: in.BaseBranch})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.abortRebase", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type abortRebaseArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[abortRebaseArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.AbortRebase(ctx, &gitgatewayv1.AbortRebaseRequest{WorktreeId: in.WorktreeID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.abortMerge", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type abortMergeArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[abortMergeArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.AbortMerge(ctx, &gitgatewayv1.AbortMergeRequest{WorktreeId: in.WorktreeID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// git.conflictOperation is a DETECTOR ONLY (worktreeId -> operation
	// string) — matches the real agent exactly, see TASK-207's Contract
	// correction section. git.resolveConflict below is a new channel (not
	// part of the original frontend catalog) for the per-file ours/theirs/
	// markResolved op TASK-212's stale sketch conflated with this one; no
	// confirmed live caller was found in today's frontend for that op.
	r.Register("git.conflictOperation", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type conflictOpArgs struct {
			WorktreeID string `json:"worktreeId"`
		}
		in, err := decodeArg[conflictOpArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ConflictOperation(ctx, &gitgatewayv1.ConflictOperationRequest{WorktreeId: in.WorktreeID})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.resolveConflict", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type resolveConflictArgs struct {
			WorktreeID string `json:"worktreeId"`
			Path       string `json:"path"`
			Operation  string `json:"operation"`
		}
		in, err := decodeArg[resolveConflictArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ResolveConflict(ctx, &gitgatewayv1.ResolveConflictRequest{
			WorktreeId: in.WorktreeID, Path: in.Path, Operation: in.Operation,
		})
		if err != nil {
			return nil, err // FAILED_PRECONDITION over relay surfaces as-is (domain.ErrConflictResolveUnsupportedOverRelay)
		}
		return resp, nil
	})

	r.Register("git.discard", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type discardArgs struct {
			WorktreeID string `json:"worktreeId"`
			Path       string `json:"path"`
		}
		in, err := decodeArg[discardArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Discard(ctx, &gitgatewayv1.DiscardRequest{WorktreeId: in.WorktreeID, Path: in.Path})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.bulkDiscard", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type bulkDiscardArgs struct {
			WorktreeID string   `json:"worktreeId"`
			Paths      []string `json:"paths"`
		}
		in, err := decodeArg[bulkDiscardArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.BulkDiscard(ctx, &gitgatewayv1.BulkDiscardRequest{WorktreeId: in.WorktreeID, Paths: in.Paths})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// ── TASK-208/TASK-212 (Group B — staging). git.stage/git.bulkStage
	// share one handler (both call the same StageRequest.Paths-typed RPC);
	// same for unstage. ──────────────────────────────────────────────

	stageHandler := func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type stageArgs struct {
			WorktreeID string   `json:"worktreeId"`
			Paths      []string `json:"paths"`
		}
		in, err := decodeArg[stageArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Stage(ctx, &gitgatewayv1.StageRequest{WorktreeId: in.WorktreeID, Paths: in.Paths})
		if err != nil {
			return nil, err
		}
		return resp, nil
	}
	r.Register("git.stage", stageHandler)
	r.Register("git.bulkStage", stageHandler)

	unstageHandler := func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type unstageArgs struct {
			WorktreeID string   `json:"worktreeId"`
			Paths      []string `json:"paths"`
		}
		in, err := decodeArg[unstageArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.Unstage(ctx, &gitgatewayv1.UnstageRequest{WorktreeId: in.WorktreeID, Paths: in.Paths})
		if err != nil {
			return nil, err
		}
		return resp, nil
	}
	r.Register("git.unstage", unstageHandler)
	r.Register("git.bulkUnstage", unstageHandler)

	// ── TASK-209/TASK-213 (shippable-now subset only: history/
	// checkIgnored/forkSync/upstreamStatus — commitCompare/branchCompare/
	// commitDiff/branchDiff/submoduleStatus are BLOCKED, not implemented,
	// not wired). Request/response shapes below match TASK-209's Contract
	// correction section, NOT TASK-213's own inline sketch (written before
	// that correction) — cursor dropped, ref renamed baseRef,
	// checkIgnored returns only the ignored subset, forkSync requires
	// expectedUpstream, upstreamStatus takes an optional pushTarget. ────

	r.Register("git.history", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type historyArgs struct {
			WorktreeID string `json:"worktreeId"`
			BaseRef    string `json:"baseRef"`
			Limit      int32  `json:"limit"`
		}
		in, err := decodeArg[historyArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.History(ctx, &gitgatewayv1.HistoryRequest{
			WorktreeId: in.WorktreeID, BaseRef: in.BaseRef, Limit: in.Limit,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.checkIgnored", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type checkIgnoredArgs struct {
			WorktreeID string   `json:"worktreeId"`
			Paths      []string `json:"paths"`
		}
		in, err := decodeArg[checkIgnoredArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.CheckIgnored(ctx, &gitgatewayv1.CheckIgnoredRequest{WorktreeId: in.WorktreeID, Paths: in.Paths})
		if err != nil {
			return nil, err
		}
		return resp.GetIgnoredPaths(), nil
	})

	r.Register("git.forkSync", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type forkSyncArgs struct {
			WorktreeID       string `json:"worktreeId"`
			ExpectedUpstream string `json:"expectedUpstream"`
		}
		in, err := decodeArg[forkSyncArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.ForkSync(ctx, &gitgatewayv1.ForkSyncRequest{
			WorktreeId: in.WorktreeID, ExpectedUpstream: in.ExpectedUpstream,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// UpstreamStatus's pushTarget is now the real, structured GitPushTarget
	// shape (agent/src/shared/types.ts:551-557) — replaces TASK-213's
	// original placeholder string field now that TASK-207's PushTargetInput
	// exists for real (same decode shape as git.fastForward above).
	r.Register("git.upstreamStatus", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type pushTargetArgs struct {
			RemoteName    string `json:"remoteName"`
			BranchName    string `json:"branchName"`
			RemoteURL     string `json:"remoteUrl"`
			RemoteCreated bool   `json:"remoteCreated"`
		}
		type upstreamStatusArgs struct {
			WorktreeID string          `json:"worktreeId"`
			PushTarget *pushTargetArgs `json:"pushTarget"`
		}
		in, err := decodeArg[upstreamStatusArgs](args, 0)
		if err != nil {
			return nil, err
		}
		req := &gitgatewayv1.UpstreamStatusRequest{WorktreeId: in.WorktreeID}
		if in.PushTarget != nil {
			req.PushTarget = &gitgatewayv1.PushTargetInput{
				RemoteName: in.PushTarget.RemoteName, BranchName: in.PushTarget.BranchName,
				RemoteUrl: in.PushTarget.RemoteURL, RemoteCreated: in.PushTarget.RemoteCreated,
			}
		}
		resp, err := client.UpstreamStatus(ctx, req)
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// ── TASK-209 real shape redesign: commitCompare/branchCompare/
	// commitDiff/branchDiff/submoduleStatus — see gitgateway.proto's
	// matching message doc comments for the real agent contract citations
	// that unblocked these (specs/agent/api/agent-rpc-catalog-git-fs.md:49-55/143-147). ──

	r.Register("git.commitCompare", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type commitCompareArgs struct {
			WorktreeID string `json:"worktreeId"`
			CommitID   string `json:"commitId"`
		}
		in, err := decodeArg[commitCompareArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.CommitCompare(ctx, &gitgatewayv1.CommitCompareRequest{
			WorktreeId: in.WorktreeID, CommitId: in.CommitID,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.branchCompare", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type branchCompareArgs struct {
			WorktreeID string `json:"worktreeId"`
			BaseRef    string `json:"baseRef"`
		}
		in, err := decodeArg[branchCompareArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.BranchCompare(ctx, &gitgatewayv1.BranchCompareRequest{
			WorktreeId: in.WorktreeID, BaseRef: in.BaseRef,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// CommitDiff/BranchDiff are per-file (filePath REQUIRED) — same class of
	// fix as git.diff's own TASK-228 correction, not the whole-commit/
	// two-sided shapes TASK-213's original sketch had.
	r.Register("git.commitDiff", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type commitDiffArgs struct {
			WorktreeID string  `json:"worktreeId"`
			CommitOID  string  `json:"commitOid"`
			ParentOID  *string `json:"parentOid"`
			FilePath   string  `json:"filePath"`
			OldPath    string  `json:"oldPath"`
		}
		in, err := decodeArg[commitDiffArgs](args, 0)
		if err != nil {
			return nil, err
		}
		req := &gitgatewayv1.CommitDiffRequest{
			WorktreeId: in.WorktreeID, CommitOid: in.CommitOID, FilePath: in.FilePath, OldPath: in.OldPath,
		}
		if in.ParentOID != nil {
			req.ParentOid = *in.ParentOID
		}
		resp, err := client.CommitDiff(ctx, req)
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.branchDiff", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type branchDiffArgs struct {
			WorktreeID string `json:"worktreeId"`
			BaseRef    string `json:"baseRef"`
			FilePath   string `json:"filePath"`
			OldPath    string `json:"oldPath"`
		}
		in, err := decodeArg[branchDiffArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.BranchDiff(ctx, &gitgatewayv1.BranchDiffRequest{
			WorktreeId: in.WorktreeID, BaseRef: in.BaseRef, FilePath: in.FilePath, OldPath: in.OldPath,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// SubmoduleStatus is per-SINGLE-submodule (submodulePath REQUIRED) — the
	// real frontend caller (frontend/src/renderer/src/runtime/runtime-git-client.ts:152-176)
	// already knows every dirty submodule's path from the parent git.status
	// response, so there is no "list every submodule" call to support here.
	r.Register("git.submoduleStatus", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type submoduleStatusArgs struct {
			WorktreeID    string `json:"worktreeId"`
			SubmodulePath string `json:"submodulePath"`
			Area          string `json:"area"`
		}
		in, err := decodeArg[submoduleStatusArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.SubmoduleStatus(ctx, &gitgatewayv1.SubmoduleStatusRequest{
			WorktreeId: in.WorktreeID, SubmodulePath: in.SubmodulePath, Area: in.Area,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// ── TASK-210/TASK-213 remote (fetch: TASK-227 reachability +
	// PushTargetInput are both now resolved, unblocking this channel). ────

	r.Register("git.fetch", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type pushTargetArgs struct {
			RemoteName    string `json:"remoteName"`
			BranchName    string `json:"branchName"`
			RemoteURL     string `json:"remoteUrl"`
			RemoteCreated bool   `json:"remoteCreated"`
		}
		type fetchArgs struct {
			WorktreeID string          `json:"worktreeId"`
			PushTarget *pushTargetArgs `json:"pushTarget"`
		}
		in, err := decodeArg[fetchArgs](args, 0)
		if err != nil {
			return nil, err
		}
		req := &gitgatewayv1.FetchRequest{WorktreeId: in.WorktreeID}
		if in.PushTarget != nil {
			req.PushTarget = &gitgatewayv1.PushTargetInput{
				RemoteName: in.PushTarget.RemoteName, BranchName: in.PushTarget.BranchName,
				RemoteUrl: in.PushTarget.RemoteURL, RemoteCreated: in.PushTarget.RemoteCreated,
			}
		}
		resp, err := client.Fetch(ctx, req)
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.remoteCommitUrl", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type remoteCommitURLArgs struct {
			WorktreeID string `json:"worktreeId"`
			SHA        string `json:"sha"`
		}
		in, err := decodeArg[remoteCommitURLArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.RemoteCommitUrl(ctx, &gitgatewayv1.RemoteCommitUrlRequest{WorktreeId: in.WorktreeID, Sha: in.SHA})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.remoteFileUrl", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type remoteFileURLArgs struct {
			WorktreeID string `json:"worktreeId"`
			Path       string `json:"path"`
			Ref        string `json:"ref"`
		}
		in, err := decodeArg[remoteFileURLArgs](args, 0)
		if err != nil {
			return nil, err
		}
		resp, err := client.RemoteFileUrl(ctx, &gitgatewayv1.RemoteFileUrlRequest{WorktreeId: in.WorktreeID, Path: in.Path, Ref: in.Ref})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// ── TASK-211/TASK-213 (fully shippable) ──────────────────────────────

	r.Register("git.generatePullRequestFields", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type genPRFieldsArgs struct {
			WorktreeID string `json:"worktreeId"`
			BaseBranch string `json:"baseBranch"`
		}
		in, err := decodeArg[genPRFieldsArgs](args, 0)
		if err != nil {
			return nil, err
		}
		genCtx, cancel := context.WithCancel(ctx)
		key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindPullRequestFields}
		cleanup := gitGenerateCancels.start(key, cancel)
		defer cleanup()
		defer cancel()

		resp, err := client.GeneratePullRequestFields(genCtx, &gitgatewayv1.GeneratePullRequestFieldsRequest{
			WorktreeId: in.WorktreeID, BaseBranch: in.BaseBranch,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	r.Register("git.cancelGeneratePullRequestFields", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[cancelGenerateArgs](args, 0)
		if err != nil {
			return nil, err
		}
		key := gitGenerateCancelKey{WorktreeID: in.WorktreeID, Kind: gitGenerateCancelKindPullRequestFields}
		gitGenerateCancels.cancel(key)
		return nil, nil
	})

	// git.discoverCommitMessageModels reads from Identity (id.TenantID/
	// id.UserID) instead of args — mirrors SOL-033's automation.create
	// note on never trusting a client-supplied tenant; there's no
	// equivalent identity field to source elsewhere for this channel.
	r.Register("git.discoverCommitMessageModels", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		resp, err := client.DiscoverCommitMessageModels(ctx, &gitgatewayv1.DiscoverCommitMessageModelsRequest{
			TenantId: id.TenantID, UserId: id.UserID,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetModels(), nil
	})
}

// ── files.* (TASK-049..060) ─────────────────────────────────────────────
//
// files.commitUpload is always-local renderer-side bookkeeping in the old
// backend (no fs I/O) — registered as a local no-op ack below, not wired to
// git-gateway-service. Every other channel dispatches through
// GitGatewayServiceClient's FileIO RPC group (SOL-009), which itself
// resolves local-vs-relay per worktree — wscompat never makes that
// decision; it only forwards worktreeId + params.
//
// files.watch/files.unwatch (BACKLOG-003) are the one exception to "no fs
// I/O here" — files.unwatch used to be documented above as always-local
// bookkeeping too, which was true only because files.watch never existed to
// have anything real to unwatch. Both now relay real fs.changed
// notifications through git-gateway-service's WatchWorktree stream — see
// registerFilesWatchChannel below, and file_watch_stream_registry.go for
// the per-connection subscriptionId bookkeeping files.unwatch needs.

// simpleFileOp wires a channel that decodes one JSON arg and issues one
// gRPC call, returning the response verbatim — the shape most of files.*'s
// RPC-backed channels share.
func simpleFileOp[Req any](
	r *Registry,
	channel string,
	call func(ctx context.Context, req Req) (any, error),
) {
	r.Register(channel, func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[Req](args, 0)
		if err != nil {
			return nil, err
		}
		return call(ctx, in)
	})
}

func registerFilesChannels(r *Registry, client gitgatewayv1.GitGatewayServiceClient) {
	type readArgs struct {
		WorktreeID string `json:"worktreeId"`
		Path       string `json:"path"`
	}
	simpleFileOp(r, "files.read", func(ctx context.Context, in readArgs) (any, error) {
		resp, err := client.ReadFile(ctx, &gitgatewayv1.ReadFileRequest{WorktreeId: in.WorktreeID, Path: in.Path})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})
	simpleFileOp(r, "files.stat", func(ctx context.Context, in readArgs) (any, error) {
		resp, err := client.StatFile(ctx, &gitgatewayv1.StatFileRequest{WorktreeId: in.WorktreeID, Path: in.Path})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})
	simpleFileOp(r, "files.readDir", func(ctx context.Context, in readArgs) (any, error) {
		resp, err := client.ReadDir(ctx, &gitgatewayv1.ReadDirRequest{WorktreeId: in.WorktreeID, Path: in.Path})
		if err != nil {
			return nil, err
		}
		return resp.GetEntries(), nil
	})

	type readChunkArgs struct {
		WorktreeID  string `json:"worktreeId"`
		Path        string `json:"path"`
		OffsetBytes int64  `json:"offsetBytes"`
		LengthBytes int64  `json:"lengthBytes"`
	}
	simpleFileOp(r, "files.readChunk", func(ctx context.Context, in readChunkArgs) (any, error) {
		resp, err := client.ReadFileChunk(ctx, &gitgatewayv1.ReadFileChunkRequest{
			WorktreeId: in.WorktreeID, Path: in.Path, OffsetBytes: in.OffsetBytes, LengthBytes: in.LengthBytes,
		})
		if err != nil {
			return nil, err // FAILED_PRECONDITION over relay surfaces as-is
		}
		return resp, nil
	})

	type readPreviewArgs struct {
		WorktreeID string `json:"worktreeId"`
		Path       string `json:"path"`
		MaxBytes   int64  `json:"maxBytes"`
	}
	simpleFileOp(r, "files.readPreview", func(ctx context.Context, in readPreviewArgs) (any, error) {
		resp, err := client.ReadFilePreview(ctx, &gitgatewayv1.ReadFilePreviewRequest{
			WorktreeId: in.WorktreeID, Path: in.Path, MaxBytes: in.MaxBytes,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// files.write / files.writeBase64 collapse onto WriteFile with an
	// encoding switch, per TASK-049's proto note that this is one RPC with
	// a wire-encoding field, not two RPCs.
	type writeArgs struct {
		WorktreeID    string `json:"worktreeId"`
		Path          string `json:"path"`
		Content       string `json:"content"`
		Base64        bool   `json:"base64"` // true for files.writeBase64
		CreateParents bool   `json:"createParents"`
	}
	writeHandler := func(ctx context.Context, in writeArgs) (any, error) {
		content := []byte(in.Content)
		if in.Base64 {
			decoded, err := base64.StdEncoding.DecodeString(in.Content)
			if err != nil {
				return nil, fmt.Errorf("decoding base64 content: %w", err)
			}
			content = decoded
		}
		resp, err := client.WriteFile(ctx, &gitgatewayv1.WriteFileRequest{
			WorktreeId: in.WorktreeID, Path: in.Path, Content: content, CreateParents: in.CreateParents,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	}
	simpleFileOp(r, "files.write", writeHandler)
	simpleFileOp(r, "files.writeBase64", writeHandler)

	type writeChunkArgs struct {
		WorktreeID  string `json:"worktreeId"`
		Path        string `json:"path"`
		OffsetBytes int64  `json:"offsetBytes"`
		Content     string `json:"content"` // always base64 per files.writeBase64Chunk's contract
		IsFinal     bool   `json:"isFinal"`
	}
	simpleFileOp(r, "files.writeBase64Chunk", func(ctx context.Context, in writeChunkArgs) (any, error) {
		content, err := base64.StdEncoding.DecodeString(in.Content)
		if err != nil {
			return nil, fmt.Errorf("decoding base64 content: %w", err)
		}
		resp, err := client.WriteFileChunk(ctx, &gitgatewayv1.WriteFileChunkRequest{
			WorktreeId: in.WorktreeID, Path: in.Path, OffsetBytes: in.OffsetBytes, Content: content, IsFinal: in.IsFinal,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	type createDirArgs struct {
		WorktreeID string `json:"worktreeId"`
		Path       string `json:"path"`
		Recursive  bool   `json:"recursive"`
		NoClobber  bool   `json:"noClobber"` // true for files.createDirNoClobber
	}
	createDirHandler := func(ctx context.Context, in createDirArgs) (any, error) {
		resp, err := client.CreateDir(ctx, &gitgatewayv1.CreateDirRequest{
			WorktreeId: in.WorktreeID, Path: in.Path, Recursive: in.Recursive, NoClobber: in.NoClobber,
		})
		if err != nil {
			return nil, err
		}
		return resp, nil
	}
	simpleFileOp(r, "files.createDir", createDirHandler)
	simpleFileOp(r, "files.createDirNoClobber", createDirHandler)

	// files.createFile has no noClobber-equivalent param — the frontend's
	// createRuntimePath (runtime-file-client.ts:395-414) never sends one for
	// the file case, so creating an already-existing file is always an
	// error (see CreateFileRequest's doc comment in gitgateway.proto).
	simpleFileOp(r, "files.createFile", func(ctx context.Context, in readArgs) (any, error) {
		resp, err := client.CreateFile(ctx, &gitgatewayv1.CreateFileRequest{WorktreeId: in.WorktreeID, Path: in.Path})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	type deleteArgs struct {
		WorktreeID string `json:"worktreeId"`
		Path       string `json:"path"`
		Recursive  bool   `json:"recursive"`
	}
	simpleFileOp(r, "files.delete", func(ctx context.Context, in deleteArgs) (any, error) {
		if _, err := client.DeleteFile(ctx, &gitgatewayv1.DeleteFileRequest{
			WorktreeId: in.WorktreeID, Path: in.Path, Recursive: in.Recursive,
		}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	})

	type searchArgs struct {
		WorktreeID string `json:"worktreeId"`
		Pattern    string `json:"pattern"`
		IsRegex    bool   `json:"isRegex"`
		PathGlob   string `json:"pathGlob"`
		MaxResults int32  `json:"maxResults"`
	}
	simpleFileOp(r, "files.search", func(ctx context.Context, in searchArgs) (any, error) {
		resp, err := client.SearchFiles(ctx, &gitgatewayv1.SearchFilesRequest{
			WorktreeId: in.WorktreeID, Pattern: in.Pattern, IsRegex: in.IsRegex, PathGlob: in.PathGlob, MaxResults: in.MaxResults,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetMatches(), nil
	})

	type listAllArgs struct {
		WorktreeID string `json:"worktreeId"`
		PathGlob   string `json:"pathGlob"`
		MaxResults int32  `json:"maxResults"`
	}
	simpleFileOp(r, "files.listAll", func(ctx context.Context, in listAllArgs) (any, error) {
		resp, err := client.ListAllFiles(ctx, &gitgatewayv1.ListAllFilesRequest{
			WorktreeId: in.WorktreeID, PathGlob: in.PathGlob, MaxResults: in.MaxResults,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetPaths(), nil
	})

	type listMarkdownArgs struct {
		WorktreeID string `json:"worktreeId"`
		MaxResults int32  `json:"maxResults"`
	}
	simpleFileOp(r, "files.listMarkdownDocuments", func(ctx context.Context, in listMarkdownArgs) (any, error) {
		resp, err := client.ListMarkdownDocuments(ctx, &gitgatewayv1.ListMarkdownDocumentsRequest{
			WorktreeId: in.WorktreeID, MaxResults: in.MaxResults,
		})
		if err != nil {
			return nil, err
		}
		return resp.GetPaths(), nil
	})

	type renameArgs struct {
		WorktreeID string `json:"worktreeId"`
		From       string `json:"fromPath"`
		To         string `json:"toPath"`
	}
	simpleFileOp(r, "files.rename", func(ctx context.Context, in renameArgs) (any, error) {
		resp, err := client.RenameFile(ctx, &gitgatewayv1.RenameFileRequest{WorktreeId: in.WorktreeID, FromPath: in.From, ToPath: in.To})
		if err != nil {
			return nil, err // FAILED_PRECONDITION over relay surfaces as-is
		}
		return resp, nil
	})
	simpleFileOp(r, "files.copy", func(ctx context.Context, in renameArgs) (any, error) {
		resp, err := client.CopyFile(ctx, &gitgatewayv1.CopyFileRequest{WorktreeId: in.WorktreeID, FromPath: in.From, ToPath: in.To})
		if err != nil {
			return nil, err
		}
		return resp, nil
	})

	// ── Always-local bookkeeping — no gRPC call, matches
	// crashReports.getLatestPending's in-process pattern. ────────────
	r.Register("files.commitUpload", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		return map[string]bool{"ok": true}, nil
	})
	registerFilesWatchChannel(r, client)
	registerFilesUnwatchChannel(r)
}

// ── files.watch / files.unwatch (BACKLOG-003) ──────────────────────────────

type filesWatchArgs struct {
	// Worktree matches every other files.*/browser.* channel's "worktree"
	// param name, always "id:"-prefixed — subscribeSharedFileWatch's real
	// call site (runtime-file-client.ts) sends
	// {worktree: toRuntimeWorktreeSelector(worktreeId)}.
	Worktree string `json:"worktree"`
}

// filesWatchReadyView is this channel's ack — see
// subscribeRuntimeStreamChannel's doc comment (runtime-rpc-client.ts): "the
// subscription's very FIRST response is the ack", which is exactly what
// frontend's RuntimeFileWatchEvent's {type:'ready', subscriptionId} case
// expects as message #1, not a push event. subscriptionId is what a later
// files.unwatch call must send back (unwatchSharedRuntimeFileWatch).
type filesWatchReadyView struct {
	Type           string `json:"type"`
	SubscriptionID string `json:"subscriptionId"`
}

// registerFilesWatchChannel wires files.watch — mirrors
// registerEphemeralVmProvisionChannel's spawn-then-open-stream-then-register
// pattern (channels_ephemeral_vm.go), server-streaming only (no
// client->server frames after the initial request, unlike AttachPty).
func registerFilesWatchChannel(r *Registry, client gitgatewayv1.GitGatewayServiceClient) {
	r.RegisterStreamChannel("files.watch", func(ctx context.Context, id Identity, args []json.RawMessage) (any, <-chan PushEvent, error) {
		in, err := decodeArg[filesWatchArgs](args, 0)
		if err != nil {
			return nil, nil, err
		}
		worktreeID := stripWorktreeSelectorPrefix(in.Worktree)
		if worktreeID == "" {
			return nil, nil, fmt.Errorf("wscompat: files.watch requires a worktree selector")
		}

		watches := fileWatchStreamsFromContext(ctx)
		if watches == nil {
			return nil, nil, errNoFileWatchStreamRegistry
		}

		subscriptionID, err := newFileWatchID()
		if err != nil {
			return nil, nil, err
		}

		// See attachContext's doc comment (channels_terminal.go): the stream
		// MUST outlive this invoke's own rpcTimeout deadline — a file watch
		// is meant to live for the rest of the pane's lifetime, not 25s.
		streamCtx, cancel := attachContext(id)
		stream, err := client.WatchWorktree(streamCtx, &gitgatewayv1.WatchWorktreeRequest{WorktreeId: worktreeID})
		if err != nil {
			cancel()
			return nil, nil, err
		}

		entry := &fileWatchStreamEntry{cancel: cancel}
		watches.put(subscriptionID, entry)

		events := make(chan PushEvent)
		go drainFileWatchOutput(streamCtx, subscriptionID, in.Worktree, stream, watches, events)

		return filesWatchReadyView{Type: "ready", SubscriptionID: subscriptionID}, events, nil
	})
}

// drainFileWatchOutput reads every FileChangeEvent git-gateway-service
// pushes for one watch until the stream ends (files.unwatch's cancel(), the
// underlying connection dropping, or a transport error), forwarding each as
// a {type:'changed', worktree, events:[...]} push — mirrors
// drainVmProvisionOutput exactly (channels_ephemeral_vm.go), plus one thing
// that has no PTY/provision equivalent: an explicit terminal {type:'end'}
// or {type:'error', message} push on stream end, since
// RuntimeFileWatchEvent's contract (runtime-file-client.ts) gives callers a
// real onError signal for 'error' that the transport's generic onClose
// callback alone can't provide.
func drainFileWatchOutput(
	streamCtx context.Context,
	subscriptionID string,
	worktreeSelector string,
	stream gitgatewayv1.GitGatewayService_WatchWorktreeClient,
	watches *fileWatchStreamRegistry,
	events chan<- PushEvent,
) {
	defer close(events)
	defer watches.remove(subscriptionID)
	for {
		ev, err := stream.Recv()
		if err != nil {
			final := map[string]any{"type": "error", "message": err.Error()}
			if errors.Is(err, io.EOF) {
				final = map[string]any{"type": "end"}
			}
			select {
			case events <- PushEvent{Channel: "files.watch", Args: []any{final}}:
			case <-streamCtx.Done():
			}
			return
		}
		push := PushEvent{Channel: "files.watch", Args: []any{toFilesWatchChangedView(worktreeSelector, ev)}}
		select {
		case events <- push:
		case <-streamCtx.Done():
			return
		}
	}
}

// toFilesWatchChangedView maps 1 gitgatewayv1.FileChangeEvent onto
// RuntimeFileWatchEvent's {type:'changed', worktree, events} shape —
// `events` is always a single-element array since each gRPC message here
// already carries exactly one change (no server-side batching), matching
// FsChangedPayload's array shape for the consumer (handleSharedRuntimeFileWatchResponse
// forwards event.events verbatim, batched or not). old_absolute_path/
// is_directory are omitted rather than sent as empty/false — see
// infrafleetv1.FileChangeEvent's doc comment for why those are never
// populated today.
func toFilesWatchChangedView(worktreeSelector string, ev *gitgatewayv1.FileChangeEvent) map[string]any {
	changeEvent := map[string]any{"kind": ev.GetKind(), "absolutePath": ev.GetAbsolutePath()}
	if ev.GetOldAbsolutePath() != "" {
		changeEvent["oldAbsolutePath"] = ev.GetOldAbsolutePath()
	}
	if ev.GetIsDirectory() {
		changeEvent["isDirectory"] = true
	}
	return map[string]any{"type": "changed", "worktree": worktreeSelector, "events": []any{changeEvent}}
}

type filesUnwatchArgs struct {
	SubscriptionID string `json:"subscriptionId"`
}

type filesUnwatchResultView struct {
	OK bool `json:"ok"`
}

// registerFilesUnwatchChannel wires files.unwatch — cancels THIS
// connection's Go-side WatchWorktree subscription (entry.cancel(), which
// unblocks entry.stream.Recv() in drainFileWatchOutput and tears down the
// gRPC stream), mirroring registerEphemeralVmCancelProvisionChannel exactly.
// An unknown/already-ended subscriptionId is NOT an error — files.unwatch
// is frequently called during unmount races (the watch may have already
// ended on its own) — {ok:true} either way, matching the OLD TS backend's
// documented always-succeeds contract for this channel.
func registerFilesUnwatchChannel(r *Registry) {
	r.Register("files.unwatch", func(ctx context.Context, _ Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[filesUnwatchArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if watches := fileWatchStreamsFromContext(ctx); watches != nil {
			if entry, ok := watches.get(in.SubscriptionID); ok {
				entry.cancel() // drainFileWatchOutput's own cleanup removes the registry entry once Recv observes the cancellation
			}
		}
		return filesUnwatchResultView{OK: true}, nil
	})
}

// backendFileTreeNode mirrors the frontend's BackendFileTreeNode type
// (WorkspaceContext.tsx:26-31 / WorkspaceContextV6.tsx) field-for-field —
// {name, path, isDir, children?}. files.readDir's DirEntry only carries
// name/is_directory (TASK-168's own doc comment already notes this shape
// mismatch is expected and massaged client-side); path is reconstructed
// here since DirEntry has none.
type backendFileTreeNode struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
}

// registerWorkspaceChannels wires the one legacy channel this pass still
// owns: workspace.refreshFileTree, per rpc-catalog.md:481-485 "mostly
// superseded by files.*/git.*". A pure rename/reshape wrapper over
// files.readDir's backing RPC (GitGatewayService.ReadDir) — no independent
// business logic beyond the projectId->worktreeId resolution every other
// project-scoped channel in this package already does (see
// channels_worktree.go's worktree.list for the identical
// projectClient.ListWorktrees precedent this mirrors).
//
// Confirmed via the real frontend call sites (WorkspaceContext.tsx:128,
// WorkspaceContextV6.tsx:157) that the actual params are {projectId, path},
// not TASK-168's own doc sketch's assumption of a direct worktreeId —
// resolved here by picking the project's active worktree the same way
// worktree-scoped operations elsewhere in this codebase do (Worktree.active,
// project.proto).
func registerWorkspaceChannels(r *Registry, gitClient gitgatewayv1.GitGatewayServiceClient, projectClient projectv1.ProjectServiceClient) {
	r.Register("workspace.refreshFileTree", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		type refreshArgs struct {
			ProjectID string `json:"projectId"`
			Path      string `json:"path"`
		}
		in, err := decodeArg[refreshArgs](args, 0)
		if err != nil {
			return nil, err
		}
		if in.ProjectID == "" {
			return nil, fmt.Errorf("wscompat: workspace.refreshFileTree requires projectId")
		}
		dirPath := in.Path
		if dirPath == "" {
			dirPath = "."
		}

		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})

		worktreesResp, err := projectClient.ListWorktrees(ctx, &projectv1.ListWorktreesRequest{ProjectId: in.ProjectID})
		if err != nil {
			return nil, err
		}
		var worktreeID string
		for _, wt := range worktreesResp.GetWorktrees() {
			if wt.GetActive() {
				worktreeID = wt.GetId()
				break
			}
		}
		if worktreeID == "" && len(worktreesResp.GetWorktrees()) > 0 {
			// No worktree explicitly marked active — fall back to the
			// first one rather than erroring, since a project with
			// exactly one worktree (the common case) has nothing to
			// disambiguate.
			worktreeID = worktreesResp.GetWorktrees()[0].GetId()
		}
		if worktreeID == "" {
			return nil, fmt.Errorf("wscompat: no worktree found for project %q", in.ProjectID)
		}

		resp, err := gitClient.ReadDir(ctx, &gitgatewayv1.ReadDirRequest{WorktreeId: worktreeID, Path: dirPath})
		if err != nil {
			return nil, err
		}
		return toBackendFileTreeNodes(dirPath, resp.GetEntries()), nil
	})
}

// toBackendFileTreeNodes maps ReadDirResponse's DirEntry list onto the
// frontend's flat {name, path, isDir} shape, joining dirPath+name since
// DirEntry itself carries no path — see backendFileTreeNode's doc comment.
func toBackendFileTreeNodes(dirPath string, entries []*gitgatewayv1.DirEntry) []backendFileTreeNode {
	out := make([]backendFileTreeNode, 0, len(entries))
	for _, e := range entries {
		childPath := e.GetName()
		if dirPath != "" && dirPath != "." {
			childPath = dirPath + "/" + e.GetName()
		}
		out = append(out, backendFileTreeNode{Name: e.GetName(), Path: childPath, IsDir: e.GetIsDirectory()})
	}
	return out
}
