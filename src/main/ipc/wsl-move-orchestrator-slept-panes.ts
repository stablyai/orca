/**
 * The window's slept-pane bindings for an automatic move (D3a): only the window knows them, and a
 * move without them misses those panes' history. Main asks; the window answers by request id.
 */
import { randomUUID } from 'node:crypto'
import type { WslMoveRequest } from '../../shared/wsl-move/wsl-move-driver-types'
import { WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL } from '../../shared/wsl-move/wsl-move-orchestrator-types'
import { getTrustedUIRendererWindow } from './ui'

const SLEPT_PANES_TIMEOUT_MS = 5_000

type SleptPanes = NonNullable<WslMoveRequest['sleptPanes']>

const sleptPaneRequests = new Map<string, (panes: SleptPanes | null) => void>()

/** The window's slept-pane bindings, which only it knows; a move without them misses their history. */
export function requestSleptPanes(): Promise<SleptPanes> {
  const window = getTrustedUIRendererWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.reject(new Error('wsl_move_window_unavailable'))
  }
  const requestId = randomUUID()
  return new Promise<SleptPanes>((resolve, reject) => {
    const timer = setTimeout(() => answer(null), SLEPT_PANES_TIMEOUT_MS)
    function answer(panes: SleptPanes | null): void {
      clearTimeout(timer)
      sleptPaneRequests.delete(requestId)
      if (panes) {
        resolve(panes)
      } else {
        reject(new Error('wsl_move_window_unavailable'))
      }
    }
    sleptPaneRequests.set(requestId, answer)
    window.webContents.send(WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL, { requestId })
  })
}

function parseSleptPanes(value: unknown): SleptPanes | null {
  if (!Array.isArray(value)) {
    return null
  }
  const panes: SleptPanes = []
  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('paneKey' in entry) ||
      !('sessionId' in entry) ||
      typeof entry.paneKey !== 'string' ||
      typeof entry.sessionId !== 'string'
    ) {
      return null
    }
    panes.push({ paneKey: entry.paneKey, sessionId: entry.sessionId })
  }
  return panes
}

/** The window's answer; an unparseable one fails the request rather than move without panes. */
export function answerWslMoveSleptPanes(requestId: string, value: unknown): void {
  sleptPaneRequests.get(requestId)?.(parseSleptPanes(value))
}
