import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../shared/worktree/id'
import { revokeCodexProjectTrustForRemovedWorkspace } from './codex/codex-project-trust-revocation'

/**
 * Revokes the Codex pre-trust Orca wrote for a workspace removed from this
 * machine, once its metadata is gone. SSH and runtime hosts write trust on
 * their own disk, so they are skipped here.
 */
export function revokeCodexTrustForRemovedLocalWorkspace(
  store: { getAllWorktreeMeta: () => Record<string, unknown> },
  worktreeId: string,
  hostId: ExecutionHostId | undefined
): void {
  const removed = splitWorktreeIdForFilesystem(worktreeId)
  if (!removed || (hostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID) {
    return
  }
  const remainingRoots = Object.keys(store.getAllWorktreeMeta()).flatMap(
    (id) => splitWorktreeIdForFilesystem(id)?.worktreePath ?? []
  )
  void revokeCodexProjectTrustForRemovedWorkspace({
    removedRoot: removed.worktreePath,
    remainingRoots
  }).catch((error) => {
    console.warn(`[agent-trust] Codex trust cleanup for ${worktreeId} failed`, error)
  })
}
