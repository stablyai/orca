import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  beginConditionalWorktreeUse,
  beginConditionalWorktreeGlobalUse
} from './conditional-worktree-removal-lease'
import { conditionalWorkspaceSessionTargets } from './conditional-workspace-session-targets'
import { splitWorktreeId } from '../../shared/worktree/id'

/** Legacy window snapshots must not introduce a surface behind the main-owned command gate. */
export function beginConditionalWorktreeSessionWrite(
  session: Partial<WorkspaceSessionState>,
  host: string
): () => void {
  const inventory = conditionalWorkspaceSessionTargets(session, host)
  if (!inventory.complete) {
    return beginConditionalWorktreeGlobalUse()
  }
  const releases: (() => void)[] = []
  try {
    for (const { workspaceId, hostId } of inventory.targets) {
      releases.push(
        hostId && splitWorktreeId(workspaceId)?.worktreePath
          ? beginConditionalWorktreeUse(workspaceId, hostId)
          : beginConditionalWorktreeGlobalUse()
      )
    }
    return () => {
      for (const release of releases) {
        release()
      }
    }
  } catch (error) {
    for (const release of releases) {
      release()
    }
    throw error
  }
}
