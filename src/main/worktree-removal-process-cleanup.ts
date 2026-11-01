import type { ExecutionHostId } from '../shared/execution-host'
import { advertisedUrlWatcher } from './ports/advertised-url-watcher'
import { localhostWorktreeLabelProxy } from './localhost-worktree-label-proxy'
import { deleteWorktreeHistoryDir } from './terminal-history-deletion'
import { recordWorkspaceCleanupRemovalSnapshotPrune } from './workspace-cleanup-removal-snapshot-prune'
import { pruneWorkspaceCleanupScanSnapshot } from './workspace-cleanup-scan-snapshot'
import { pruneWorkspaceSpaceAnalysisSnapshot } from './workspace-space-analysis-snapshot'

/** Drop host-blind process state only when no same-ID workspace survives on another host. */
export function dropRemovedWorktreeProcessState(worktreeId: string): void {
  advertisedUrlWatcher.forgetWorktree(worktreeId)
  localhostWorktreeLabelProxy.unregisterWorktree(worktreeId)
  // Guarded here: removal purges must degrade, not reject, when AppEnvironment
  // is uninitialized and the history root cannot be resolved.
  try {
    deleteWorktreeHistoryDir(worktreeId)
  } catch (err) {
    console.warn(
      `[pty:history] Failed to delete history dir: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/** Removed workspaces must never resurrect from the persisted cleanup/space scan snapshots. */
export function pruneRemovedWorktreeSnapshots(
  snapshotDirectory: string,
  worktreeId: string,
  hostId: ExecutionHostId | undefined,
  snapshotPruneBatchId?: string
): void {
  if (snapshotPruneBatchId) {
    recordWorkspaceCleanupRemovalSnapshotPrune(snapshotDirectory, {
      batchId: snapshotPruneBatchId,
      worktreeId,
      executionHostId: hostId
    })
    return
  }
  void pruneWorkspaceCleanupScanSnapshot(snapshotDirectory, worktreeId, hostId)
  void pruneWorkspaceSpaceAnalysisSnapshot(snapshotDirectory, worktreeId, hostId)
}
