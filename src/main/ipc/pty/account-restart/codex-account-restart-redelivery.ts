import { codexAccountRestartStops } from './codex-account-restart-stops'
import { ptyIncarnationById } from '../provider/ownership-state'
import type { TerminalIntentionalStops } from '../../../runtime/terminal/stop/terminal-intentional-stops'

type RestartExitWindow = {
  mainWindow?: { isDestroyed(): boolean } | null
  rendererPtyDispatcherReady?: boolean
}

/** Whether a restart exit sent now reaches a window whose PTY dispatcher is listening. */
export function isRestartExitRendererLive(session: RestartExitWindow): boolean {
  return Boolean(
    session.mainWindow && !session.mainWindow.isDestroyed() && session.rendererPtyDispatcherReady
  )
}

/** Gives a newly ready window the restart exits that no window received, still labeled as restarts. */
export function redeliverOwedCodexRestartExits(deps: {
  intentionalPtyStops?: TerminalIntentionalStops
  sendPtyExitToRenderer: (payload: { id: string; code: number; incarnationId?: string }) => void
}): void {
  for (const exit of codexAccountRestartStops.takeOwedRendererExits()) {
    const liveIncarnationId = ptyIncarnationById.get(exit.ptyId)
    if (liveIncarnationId !== undefined && liveIncarnationId !== exit.incarnationId) {
      // The id now belongs to a successor; the old exit must not clean up its pane state.
      continue
    }
    // The original label may have expired; the pane must still be kept for its resume.
    const settle = deps.intentionalPtyStops?.mark(exit.ptyId, 'replaced', exit.incarnationId)
    try {
      deps.sendPtyExitToRenderer({ id: exit.ptyId, code: -1, incarnationId: exit.incarnationId })
    } finally {
      settle?.(true)
    }
  }
}
