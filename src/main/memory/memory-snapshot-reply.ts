import type { MemorySnapshot } from '../../shared/diagnostics/process-stats-types'

// Paired clients draw a short sparkline; full 60-point histories on every workspace can push a
// large host's reply past the RPC size limit, which a client shows as the host being unreachable.
export const MEMORY_REPLY_HISTORY_POINTS = 20

/** The snapshot as sent over RPC: every row, each with only its most recent history points. */
export function toMemorySnapshotReply(snapshot: MemorySnapshot): MemorySnapshot {
  return {
    ...snapshot,
    app: { ...snapshot.app, history: snapshot.app.history.slice(-MEMORY_REPLY_HISTORY_POINTS) },
    worktrees: snapshot.worktrees.map((worktree) => ({
      ...worktree,
      history: worktree.history.slice(-MEMORY_REPLY_HISTORY_POINTS)
    }))
  }
}
