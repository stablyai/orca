import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../shared/workspace-layout/terminal-leaf-move'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import type { TerminalTopologyCommitContext } from './terminal-topology-commit'
import { planTerminalLeafMove, writeMovedLeafProfileRecords } from './terminal-leaf-move'
import { keepFrozen } from './layout-command-commit'
import { writeRestorable } from './restorable-write'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

export function commitLeafMove(
  request: TerminalLeafMoveRequest,
  context: TerminalTopologyCommitContext
): DurableProfileStateMutation<TerminalLeafMoveResult> {
  const { state } = context
  const planned = planTerminalLeafMove(
    context.hostIds().map((hostId) => ({ hostId, session: context.getSession(hostId) })),
    request
  )
  if (planned.sessions.length === 0) {
    return { value: planned.result, persist: false }
  }
  const handoffRestores: (() => void)[] = []
  for (const { hostId, session } of planned.sessions) {
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      const restore = context.terminalWrite?.(
        request.worktreeId,
        context.getSession(hostId),
        keepFrozen(hostId, session, context),
        [request.sourceTabId, request.targetTabId]
      )
      if (restore) {
        handoffRestores.push(restore)
      }
    }
  }
  const restores = planned.sessions.map(({ hostId, session }) =>
    writeRestorable(
      () => context.getSession(hostId),
      (value) => context.markDirty(assignWorkspaceSessionPartition(state, hostId, value)),
      keepFrozen(hostId, session, context)
    )
  )
  restores.push(...writeMovedLeafProfileRecords(request, context))
  return {
    value: planned.result,
    rollback: () => {
      restores.forEach((restore) => restore())
      handoffRestores.toReversed().forEach((restore) => restore())
    }
  }
}
