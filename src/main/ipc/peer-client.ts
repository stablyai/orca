import { ipcMain, BrowserWindow } from 'electron'
import { userInfo } from 'node:os'
import type { Store } from '../persistence'
import type {
  PeerClientService,
  PeerClientConnectResult,
  PeerClientStatus
} from '../runtime/peer-client-service'
import { getOrcaProfileListState } from '../orca-profiles/profile-index-store'
import { parsePairingCode } from '../../shared/pairing'
import type { PeerTerminalStreamEvent } from '../../shared/peer-terminal-stream-event'
import type { PeerPresenceEvent, PeerPresenceState } from '../../shared/peer-presence-event'
import type { SavedPeerPairing } from '../../shared/peer-client-status'

// Why: mirrors the account-name-then-OS-username fallback so a first-time
// connect dialog can prefill without the user typing anything.
function resolveDefaultPeerDisplayName(): string {
  const { activeProfileId, profiles } = getOrcaProfileListState()
  const active = profiles.find((profile) => profile.id === activeProfileId)
  if (active?.kind === 'cloud-linked') {
    return active.cloud?.displayName || active.name
  }
  try {
    return userInfo().username
  } catch {
    return active?.name ?? 'Orca'
  }
}

export function registerPeerClientHandlers(service: PeerClientService, store: Store): void {
  // Why: a code is only worth persisting once the handshake actually
  // authenticates — set right before service.connect() and consumed by the
  // onStatusChange listener below, which fires 'connected' or 'closed'.
  let pendingPairingCode: string | null = null

  ipcMain.handle('peerClient:getDefaultDisplayName', () => ({
    name: store.getSettings().peerCollabDisplayName || resolveDefaultPeerDisplayName()
  }))

  ipcMain.handle(
    'peerClient:connect',
    (_event, args: { pairingCode: string; displayName: string }): PeerClientConnectResult => {
      const displayName = args.displayName.trim()
      if (displayName) {
        store.updateSettings({ peerCollabDisplayName: displayName })
      }
      pendingPairingCode = args.pairingCode
      return service.connect(args.pairingCode, displayName)
    }
  )

  ipcMain.handle('peerClient:disconnect', () => {
    service.disconnect()
    return { ok: true }
  })

  ipcMain.handle('peerClient:getSavedPairing', (): SavedPeerPairing | null => {
    const savedCode = store.getSettings().peerCollabSavedPairingCode
    if (!savedCode) {
      return null
    }
    return { endpoint: parsePairingCode(savedCode)?.endpoint ?? null }
  })

  ipcMain.handle('peerClient:forgetSavedPairing', () => {
    store.updateSettings({ peerCollabSavedPairingCode: undefined })
    return { ok: true }
  })

  ipcMain.handle('peerClient:connectSaved', (): PeerClientConnectResult => {
    const savedCode = store.getSettings().peerCollabSavedPairingCode
    if (!savedCode) {
      return { ok: false, reason: 'no_saved_pairing' }
    }
    const displayName = store.getSettings().peerCollabDisplayName || resolveDefaultPeerDisplayName()
    pendingPairingCode = savedCode
    return service.connect(savedCode, displayName)
  })

  ipcMain.handle('peerClient:getStatus', (): PeerClientStatus => service.getStatus())

  ipcMain.handle('peerClient:listHostTerminals', async () => {
    try {
      return { ok: true as const, terminals: await service.listHostTerminals() }
    } catch (error) {
      return {
        ok: false as const,
        reason: error instanceof Error ? error.message : 'unknown_error'
      }
    }
  })

  ipcMain.handle(
    'peerClient:subscribeTerminal',
    (event, args: { terminal: string; cols: number; rows: number }) => {
      const sender = event.sender
      // Why: subscribeTerminal never emits synchronously, so requestId is
      // captured before any event using it can fire.
      let requestId: string | null = null
      const result = service.subscribeTerminal(
        args.terminal,
        { cols: args.cols, rows: args.rows },
        (streamEvent: PeerTerminalStreamEvent) => {
          if (requestId && !sender.isDestroyed()) {
            sender.send('peerClient:terminalStreamEvent', { requestId, event: streamEvent })
          }
        }
      )
      if (result.ok) {
        requestId = result.requestId
      }
      return result
    }
  )

  ipcMain.handle('peerClient:unsubscribeTerminal', (_event, args: { requestId: string }) => {
    service.unsubscribeTerminal(args.requestId)
    return { ok: true }
  })

  ipcMain.handle('peerClient:getClientId', () => ({ clientId: service.getClientId() }))

  ipcMain.handle('peerClient:subscribePresence', (event, args: { terminal: string }) => {
    const sender = event.sender
    let requestId: string | null = null
    const result = service.subscribePresence(args.terminal, (presenceEvent: PeerPresenceEvent) => {
      if (requestId && !sender.isDestroyed()) {
        sender.send('peerClient:presenceEvent', { requestId, event: presenceEvent })
      }
    })
    if (result.ok) {
      requestId = result.requestId
    }
    return result
  })

  ipcMain.handle('peerClient:unsubscribePresence', (_event, args: { requestId: string }) => {
    service.unsubscribePresence(args.requestId)
    return { ok: true }
  })

  ipcMain.handle(
    'peerClient:sendPresenceState',
    (_event, args: { terminal: string; state: PeerPresenceState }) => {
      service.sendPresenceState(args.terminal, args.state)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'peerClient:listTerminalSubscribers',
    async (_event, args: { terminal: string }) => {
      try {
        return {
          ok: true as const,
          subscribers: await service.listTerminalSubscribers(args.terminal)
        }
      } catch (error) {
        return {
          ok: false as const,
          reason: error instanceof Error ? error.message : 'unknown_error'
        }
      }
    }
  )

  ipcMain.handle(
    'peerClient:sendTerminalInput',
    (_event, args: { requestId: string; data: string }) => ({
      ok: service.sendTerminalInput(args.requestId, args.data)
    })
  )

  ipcMain.handle(
    'peerClient:resizeTerminalStream',
    (_event, args: { requestId: string; cols: number; rows: number }) => ({
      ok: service.resizeTerminalStream(args.requestId, args.cols, args.rows)
    })
  )

  service.onStatusChange((status) => {
    if (status.state === 'connected' && pendingPairingCode) {
      store.updateSettings({ peerCollabSavedPairingCode: pendingPairingCode })
      pendingPairingCode = null
    } else if (status.state === 'closed') {
      pendingPairingCode = null
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('peerClient:statusChanged', status)
      }
    }
  })
}
