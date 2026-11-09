import { ptyIncarnationById } from '../provider/ownership-state'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import type { LegacyTerminalRestoreAttempt } from '../../../pty/legacy-terminal-restore-ownership'

const completionSurface = Symbol('terminalCompletionSurface')
type Surface = { terminalHandle: string; tabId: string; leafId: string }
type Carrier = {
  [completionSurface]?: { id: string; incarnationId?: string; resolve: () => Surface }
}

/** A completed process can move without becoming an adopted process. */
export function publishTerminalCompletionSurface(
  response: PtySpawnResult,
  result: PtySpawnResult,
  attempt: LegacyTerminalRestoreAttempt,
  terminalHandle: string
): void {
  Object.assign(response, {
    [completionSurface]: {
      id: result.id,
      incarnationId: result.incarnationId,
      resolve: () => {
        if (attempt.closed || !attempt.tabId || !attempt.leafId) {
          throw new Error('terminal_pane_owner_changed')
        }
        return { terminalHandle, tabId: attempt.tabId, leafId: attempt.leafId }
      }
    }
  })
}

export function terminalCompletionSurface(result: PtySpawnResult): Surface | undefined {
  const carrier: PtySpawnResult & Carrier = result
  const capability = carrier[completionSurface]
  if (!capability) {
    return
  }
  if (capability.id !== result.id || capability.incarnationId !== result.incarnationId) {
    throw new Error('terminal_pane_owner_changed')
  }
  const current = ptyIncarnationById.get(result.id)
  if (current !== undefined && current !== result.incarnationId) {
    throw new Error('terminal_pane_owner_changed')
  }
  return capability.resolve()
}
