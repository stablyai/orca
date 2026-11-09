import { getPtyIpc } from '../pty-host-bindings'
import type { Store } from '../../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { rekeyMovedPaneOwners } from '../../../runtime/terminal/identity/moved-pane-owner-rekey'
import { commitRelayedPaneMove } from '../../../window/terminal-pane-move-commit-fence'
import {
  isTerminalLeafMoveRequest,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../../shared/workspace-layout/terminal-leaf-move'

/** Durable move first; agent-status and orchestration keys follow only a committed move. */
export async function commitLeafMoveAndRekey(
  deps: {
    store?: { moveTerminalLeafToNewTab?: Store['moveTerminalLeafToNewTab'] }
    runtime?: OrcaRuntimeService
  },
  request: TerminalLeafMoveRequest
): Promise<TerminalLeafMoveResult> {
  const result = (await deps.store?.moveTerminalLeafToNewTab?.(request)) ?? {
    status: 'not_held'
  }
  if (result.status !== 'moved') {
    return result
  }
  rekeyMovedPaneOwners(deps.runtime, { ...request, ptyId: result.ptyId })
  return result
}

export function installPtyLeafMoveIpcHandler(deps: {
  store?: Store
  runtime?: OrcaRuntimeService
}): void {
  getPtyIpc().handle('pty:moveLeafToNewTab', async (event, args: unknown) => {
    if (!isTerminalLeafMoveRequest(args)) {
      return { status: 'refused', reason: 'invalid_request' } satisfies TerminalLeafMoveResult
    }
    return commitRelayedPaneMove(event.sender, args.targetTabId, () =>
      commitLeafMoveAndRekey(deps, args)
    )
  })
}
