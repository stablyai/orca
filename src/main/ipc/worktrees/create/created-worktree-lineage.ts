import type { Store } from '../../../persistence'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult
} from '../../../../shared/worktree/create-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { readWorkspaceLineageParent } from '../../../worktree-lineage-parent'

type CreatedWorktreeLineageRecords = Pick<CreateWorktreeResult, 'lineage' | 'workspaceLineage'>
const NO_CREATED_WORKTREE_LINEAGE: CreatedWorktreeLineageRecords = {
  lineage: null,
  workspaceLineage: null
}

export function assertAttachableParentWorkspace(
  store: Store,
  parentWorkspace: CreateWorktreeArgs['parentWorkspace'],
  childWorkspaceKey: ReturnType<typeof worktreeWorkspaceKey>,
  hostId: ExecutionHostId
): ReturnType<typeof readWorkspaceLineageParent> {
  if (!parentWorkspace) {
    return null
  }
  if (parentWorkspace === childWorkspaceKey) {
    throw new Error('A worktree cannot be attached to itself.')
  }
  if (!parseWorkspaceKey(parentWorkspace)) {
    throw new Error(`Invalid parent workspace: ${parentWorkspace}`)
  }
  const parent = readWorkspaceLineageParent(store, parentWorkspace, hostId)
  if (!parent) {
    console.warn(
      'Parent workspace is unavailable on the creation host; creating unattached.',
      parentWorkspace
    )
  }
  return parent
}

export function recordWorkspaceLineageForCreatedWorktree(
  store: Store,
  args: CreateWorktreeArgs,
  worktree: Worktree,
  createdAt: number,
  hostId: ExecutionHostId,
  capturedParent: ReturnType<typeof readWorkspaceLineageParent>
): CreatedWorktreeLineageRecords {
  if (!args.parentWorkspace || !worktree.instanceId || !capturedParent) {
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const childWorkspaceKey = worktreeWorkspaceKey(worktree.id)
  const parentScope = parseWorkspaceKey(args.parentWorkspace)
  const parent = readWorkspaceLineageParent(store, args.parentWorkspace, hostId)
  if (
    !parentScope ||
    childWorkspaceKey === args.parentWorkspace ||
    !parent ||
    parent.instanceId !== capturedParent.instanceId
  ) {
    return NO_CREATED_WORKTREE_LINEAGE
  }
  const lineage =
    parentScope.type === 'worktree' && parent.instanceId
      ? store.setWorktreeLineage(worktree.id, {
          worktreeId: worktree.id,
          worktreeInstanceId: worktree.instanceId,
          parentWorktreeId: parentScope.worktreeId,
          parentWorktreeInstanceId: parent.instanceId,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt
        })
      : null
  const workspaceLineage = store.setWorkspaceLineage({
    childWorkspaceKey,
    childInstanceId: worktree.instanceId,
    parentWorkspaceKey: args.parentWorkspace,
    parentInstanceId: parent.instanceId,
    origin: 'manual',
    capture: {
      source: parentScope.type === 'worktree' ? 'manual-action' : 'active-workspace',
      confidence: 'explicit'
    },
    createdAt
  })
  return { lineage, workspaceLineage }
}
