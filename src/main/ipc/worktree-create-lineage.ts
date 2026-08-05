import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type {
  CreateWorktreeArgs,
  CreateWorktreeParentCaptureSource,
  Worktree,
  WorktreeLineage
} from '../../shared/types'

type WorktreeLineageStore = {
  getWorktreeMeta(worktreeId: string): { instanceId?: string } | undefined
  setWorktreeLineage(worktreeId: string, lineage: WorktreeLineage): WorktreeLineage
}

// Why: mirrors the runtime create path (recordCreatedWorktreeLineage) for in-app
// creates — sidebar nesting reads only worktree lineage, so a worktree-type
// parentWorkspace must land there, not just in workspace lineage.
export function recordWorktreeLineageForCreatedWorktree(
  store: WorktreeLineageStore,
  parentWorkspace: CreateWorktreeArgs['parentWorkspace'],
  worktree: Pick<Worktree, 'id' | 'instanceId'>,
  createdAt: number,
  captureSource: CreateWorktreeParentCaptureSource = 'active-workspace'
): WorktreeLineage | null {
  if (!parentWorkspace || !worktree.instanceId) {
    return null
  }
  const parentScope = parseWorkspaceKey(parentWorkspace)
  if (parentScope?.type !== 'worktree' || parentScope.worktreeId === worktree.id) {
    return null
  }
  const parentInstanceId = store.getWorktreeMeta(parentScope.worktreeId)?.instanceId
  if (!parentInstanceId) {
    return null
  }
  return store.setWorktreeLineage(worktree.id, {
    worktreeId: worktree.id,
    worktreeInstanceId: worktree.instanceId,
    parentWorktreeId: parentScope.worktreeId,
    parentWorktreeInstanceId: parentInstanceId,
    origin: 'manual',
    capture: { source: captureSource, confidence: 'explicit' },
    createdAt
  })
}
