import { getPtyIpc } from '../../pty-host-bindings'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { rekeyMovedPaneOwners } from '../../../runtime/moved-pane-owner-rekey'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  isTerminalLeafIntoTabRequest,
  isTerminalLeafMoveRequest,
  type TerminalLeafIntoTabRequest,
  type TerminalLeafIntoTabResult,
  type TerminalLeafMoveRequest,
  type TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'

/** Durable move first; agent-status and orchestration keys follow only a committed move. */
export async function commitLeafMoveAndRekey(
  deps: { store?: Store; runtime?: OrcaRuntimeService },
  request: TerminalLeafMoveRequest
): Promise<TerminalLeafMoveResult> {
  if (!deps.store) {
    return { status: 'not_held' }
  }
  const result = await deps.store.moveTerminalLeafToNewTab(request)
  if (result.status !== 'moved') {
    return result
  }
  rekeyMovedPaneOwners(deps.runtime, { ...request, ptyId: result.ptyId })
  return result
}

/** The join into an existing tab: the same ordering, and nothing is re-keyed for a refusal or not_held. */
export async function commitLeafIntoTabAndRekey(
  deps: { store?: Store; runtime?: OrcaRuntimeService },
  request: TerminalLeafIntoTabRequest
): Promise<TerminalLeafIntoTabResult> {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    // Layout-owner builds draw every move from main's frames; a window-applied join would land twice.
    return { status: 'refused', reason: 'layout_owner_build' }
  }
  if (!deps.store) {
    return { status: 'not_held' }
  }
  const result = await deps.store.moveTerminalLeafIntoTab(request)
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
  getPtyIpc().handle('pty:moveLeafToNewTab', async (_event, args: unknown) => {
    if (!isTerminalLeafMoveRequest(args)) {
      return { status: 'refused', reason: 'invalid_request' } satisfies TerminalLeafMoveResult
    }
    return commitLeafMoveAndRekey(deps, args)
  })
  getPtyIpc().handle('pty:moveLeafIntoTab', async (_event, args: unknown) => {
    if (!isTerminalLeafIntoTabRequest(args)) {
      return { status: 'refused', reason: 'invalid_request' } satisfies TerminalLeafIntoTabResult
    }
    return commitLeafIntoTabAndRekey(deps, args)
  })
}
