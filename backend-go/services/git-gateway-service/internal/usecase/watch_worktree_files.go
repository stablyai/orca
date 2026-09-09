package usecase

import (
	"context"

	"github.com/stablyai/orca-go/common/apperrors"
)

// WatchWorktreeFilesInput mirrors the gRPC request 1:1.
type WatchWorktreeFilesInput struct {
	WorktreeID string
}

// WatchWorktreeFiles (BACKLOG-003) resolves worktreeID exactly like every
// other files.*/git.* usecase (dispatchExecutor's ConnectionResolver
// pattern), then subscribes to that connection's fs.changed stream via
// FileWatchStreamer. Deliberately no local-host fallback — see
// FileWatchStreamer's doc comment for why a Connected=false worktree is a
// real, typed error here instead of a silent no-op watch.
type WatchWorktreeFiles struct {
	resolver ConnectionResolver
	streamer FileWatchStreamer
}

func NewWatchWorktreeFiles(resolver ConnectionResolver, streamer FileWatchStreamer) *WatchWorktreeFiles {
	return &WatchWorktreeFiles{resolver: resolver, streamer: streamer}
}

// Execute mirrors GetStatus.Execute's shape but returns a stream — see
// FileWatchStreamer.StreamFileChanges's doc comment for the
// exactly-once-unsubscribe contract the caller (adapter/grpc's
// WatchWorktree handler, via defer) must honor.
func (uc *WatchWorktreeFiles) Execute(ctx context.Context, in WatchWorktreeFilesInput) (<-chan FileChangeEvent, func(), error) {
	if in.WorktreeID == "" {
		return nil, nil, apperrors.New(apperrors.KindInvalidArgument, "GITGATEWAY_MISSING_WORKTREE_ID", "worktree_id is required", nil)
	}

	conn, err := uc.resolver.ResolveConnection(ctx, in.WorktreeID)
	if err != nil {
		return nil, nil, apperrors.New(apperrors.KindInternal, "GITGATEWAY_RESOLVE_FAILED", "failed to resolve worktree's owning host", err)
	}
	if !conn.Connected {
		// BACKLOG-003 is scoped to remote/environment targets only — a
		// host-local worktree (Connected=false) has no agent to relay
		// fs.watch to. Honest FailedPrecondition, not a silent no-op watch
		// or a fabricated local-fs.watch fallback nobody asked for here.
		return nil, nil, apperrors.New(apperrors.KindFailedPrecondition, "GITGATEWAY_WATCH_NOT_CONNECTED", "this worktree has no dev server connection to watch — file-watch is only supported for remote/environment targets", nil)
	}

	events, unsubscribe, err := uc.streamer.StreamFileChanges(ctx, conn.ConnectionID, conn.RepoPath)
	if err != nil {
		return nil, nil, apperrors.New(apperrors.KindInternal, "GITGATEWAY_WATCH_FAILED", "failed to subscribe to file changes", err)
	}
	return events, unsubscribe, nil
}
