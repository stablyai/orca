import type {
  TerminalLeafIntoTabRequest,
  TerminalLeafIntoTabResult
} from '../../../shared/terminal-leaf-move'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import { keepFrozen } from './layout-command-commit'
import { writeRestorable } from './restorable-write'
import { writeMovedLeafProfileRecords } from './terminal-leaf-move'
import { planTerminalLeafMoveIntoTab } from './terminal-leaf-move-into-tab'
import { traced, type TerminalTopologyCommitContext } from './terminal-topology-commit'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

/**
 * Joins a leaf into an existing tab and closes the emptied source tab, with the pane-keyed profile
 * records and the physical-key alias, in one durable mutation. Kept apart from the new-tab commit,
 * which is near its size cap.
 */
export function moveLeafIntoTab(
  request: TerminalLeafIntoTabRequest,
  context: TerminalTopologyCommitContext
): () => DurableProfileStateMutation<TerminalLeafIntoTabResult> {
  return traced(
    'move_leaf_into_tab',
    () => commitLeafMoveIntoTab(request, context),
    (result) => (result.status === 'refused' ? result.reason : undefined)
  )
}

function commitLeafMoveIntoTab(
  request: TerminalLeafIntoTabRequest,
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<TerminalLeafIntoTabResult> {
  if (isWslMoveWorkspaceSessionFrozen(request.worktreeId)) {
    // keepFrozen would drop the write while this still answered `moved`, and the window would close the source tab.
    return { value: { status: 'refused', reason: 'workspace_frozen' }, persist: false }
  }
  const planned = planTerminalLeafMoveIntoTab(
    context.hostIds().map((hostId) => ({ hostId, session: context.getSession(hostId) })),
    request
  )
  if (planned.result.status !== 'moved') {
    return { value: planned.result, persist: false }
  }
  if (planned.staleDroppedPtyIds.length > 0) {
    // Count only: a stale id is still someone's PTY, and this move does not own its fate.
    console.warn(`[topology] join dropped ${planned.staleDroppedPtyIds.length} stale PTY id(s)`)
  }
  const restores = planned.sessions.map(({ hostId, session }) =>
    writeRestorable(
      () => context.getSession(hostId),
      (value) => context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
      keepFrozen(hostId, session, context)
    )
  )
  restores.push(
    ...writeMovedLeafProfileRecords({ ...request, ptyId: planned.result.ptyId }, context)
  )
  return {
    value: planned.result,
    rollback: () => restores.forEach((restore) => restore())
  }
}
