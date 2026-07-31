import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PeerPresenceEvent, PeerPresenceState } from '../../shared/peer-presence-event'

let sessionSeq = 0
const activeSessions = new Map<string, { terminal: string; unsubscribe: () => void }>()

// Why: bridges the host's own terminal panes into the presence fan-out peer
// clients already use (OrcaRuntimeService.onPeerPresence/dispatchPeerPresence),
// so the host can see connected peers' cursors and peers can see the host's.
// This stays off the RPC/streaming-transport path (runtime:call's dispatch()
// rejects streaming methods, and terminal.presence.subscribe is one) since the
// host call is already in-process and doesn't need peer-grant checks.
export function registerTerminalHostPresenceHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.handle('terminalHostPresence:subscribe', (event, args: { terminal: string }) => {
    const sender = event.sender
    const sessionId = `host-presence-${++sessionSeq}`
    const unsubscribe = runtime.onPeerPresence(
      args.terminal,
      sessionId,
      (presenceEvent: PeerPresenceEvent) => {
        if (!sender.isDestroyed()) {
          sender.send('terminalHostPresence:event', { requestId: sessionId, event: presenceEvent })
        }
      }
    )
    activeSessions.set(sessionId, { terminal: args.terminal, unsubscribe })
    return { ok: true as const, requestId: sessionId }
  })

  ipcMain.handle('terminalHostPresence:unsubscribe', (_event, args: { requestId: string }) => {
    const session = activeSessions.get(args.requestId)
    if (session) {
      session.unsubscribe()
      // Why: tell every other viewer the host's own cursor/selection is gone,
      // mirroring terminal.presence.subscribe's cleanup for peer clients.
      runtime.dispatchPeerPresence(session.terminal, args.requestId, {
        type: 'left',
        terminal: session.terminal,
        clientId: 'host'
      })
      activeSessions.delete(args.requestId)
    }
    return { ok: true }
  })

  ipcMain.handle(
    'terminalHostPresence:send',
    (_event, args: { requestId: string; terminal: string; state: PeerPresenceState }) => {
      runtime.dispatchPeerPresence(args.terminal, args.requestId, {
        type: 'state',
        terminal: args.terminal,
        state: args.state
      })
      return { ok: true }
    }
  )
}
