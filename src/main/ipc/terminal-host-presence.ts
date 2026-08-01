import { ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PeerPresenceEvent, PeerPresenceState } from '../../shared/peer-presence-event'

let sessionSeq = 0
const activeSessions = new Map<
  string,
  {
    terminal: string
    owner: Electron.WebContents
    unsubscribe: () => void
    releaseSenderBinding: () => void
  }
>()

// Why: bridges the host's own terminal panes into the presence fan-out peer
// clients already use (OrcaRuntimeService.onPeerPresence/dispatchPeerPresence),
// so the host can see connected peers' cursors and peers can see the host's.
// This stays off the RPC/streaming-transport path (runtime:call's dispatch()
// rejects streaming methods, and terminal.presence.subscribe is one) since the
// host call is already in-process and doesn't need peer-grant checks.
export function registerTerminalHostPresenceHandlers(runtime: OrcaRuntimeService): void {
  function endSession(requestId: string): void {
    const session = activeSessions.get(requestId)
    if (!session) {
      return
    }
    session.unsubscribe()
    session.releaseSenderBinding()
    // Why: tell every other viewer the host's own cursor/selection is gone,
    // mirroring terminal.presence.subscribe's cleanup for peer clients.
    runtime.dispatchPeerPresence(session.terminal, requestId, {
      type: 'left',
      terminal: session.terminal,
      clientId: 'host'
    })
    activeSessions.delete(requestId)
  }

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
    // Why: a window reload or close never sends the explicit unsubscribe, which
    // would leave this session in the fan-out for the life of the process.
    const onDestroyed = (): void => endSession(sessionId)
    sender.once('destroyed', onDestroyed)
    activeSessions.set(sessionId, {
      terminal: args.terminal,
      owner: sender,
      unsubscribe,
      releaseSenderBinding: () => sender.removeListener('destroyed', onDestroyed)
    })
    return { ok: true as const, requestId: sessionId }
  })

  ipcMain.handle('terminalHostPresence:unsubscribe', (event, args: { requestId: string }) => {
    // Why: session ids are sequential, so only the sender that subscribed may
    // end its session — another window guessing an id must not tear it down.
    const session = activeSessions.get(args.requestId)
    if (session && session.owner === event.sender) {
      endSession(args.requestId)
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
