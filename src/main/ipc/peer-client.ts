import { ipcMain, BrowserWindow } from 'electron'
import { userInfo } from 'node:os'
import type { Store } from '../persistence'
import {
  readSavedPeerPairings,
  upsertSavedPeerPairing,
  hostIdForPairingCode,
  type PeerClientManager,
  type PeerClientManagerConnectResult
} from '../runtime/peer-client-manager'
import { getOrcaProfileListState } from '../orca-profiles/profile-index-store'
import { parsePairingCode } from '../../shared/pairing'
import type { PeerTerminalStreamEvent } from '../../shared/peer-terminal-stream-event'
import type { PeerPresenceEvent, PeerPresenceState } from '../../shared/peer-presence-event'
import type { PeerClientStatusWithHost } from '../../shared/peer-client-status'

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

function savedPairingCodes(store: Store): string[] {
  const settings = store.getSettings()
  return readSavedPeerPairings(
    settings.peerCollabSavedPairings,
    settings.peerCollabSavedPairingCode
  )
}

export function registerPeerClientHandlers(manager: PeerClientManager, store: Store): void {
  // Why: a code is only worth persisting once the handshake actually
  // authenticates — set right before manager.connect() and consumed by the
  // onStatusChange listener below, which fires 'connected' or 'closed'.
  const pendingPairingCodes = new Map<string, string>()
  // Why: requestId is a per-service counter, so it alone can't disambiguate
  // which host's service owns a later unsubscribe/input/resize call.
  const terminalHosts = new Map<string, string>()
  const presenceHosts = new Map<string, string>()

  ipcMain.handle('peerClient:getDefaultDisplayName', () => ({
    name: store.getSettings().peerCollabDisplayName || resolveDefaultPeerDisplayName()
  }))

  ipcMain.handle(
    'peerClient:connect',
    (
      _event,
      args: { pairingCode: string; displayName: string }
    ): PeerClientManagerConnectResult => {
      if (store.getSettings().peerCollabClientEnabled !== true) {
        return { ok: false, reason: 'client_disabled' }
      }
      const displayName = args.displayName.trim()
      if (displayName) {
        store.updateSettings({ peerCollabDisplayName: displayName })
      }
      const result = manager.connect(args.pairingCode, displayName)
      if (result.ok) {
        pendingPairingCodes.set(result.hostId, args.pairingCode)
      }
      return result
    }
  )

  ipcMain.handle('peerClient:disconnect', (_event, args: { hostId: string }) => {
    manager.disconnect(args.hostId)
    return { ok: true }
  })

  ipcMain.handle('peerClient:disconnectAll', () => {
    manager.disconnectAll()
    return { ok: true }
  })

  ipcMain.handle('peerClient:getClientEnabled', () => ({
    enabled: store.getSettings().peerCollabClientEnabled === true
  }))

  ipcMain.handle('peerClient:setClientEnabled', (_event, args: { enabled: boolean }) => {
    store.updateSettings({ peerCollabClientEnabled: args.enabled })
    if (!args.enabled) {
      manager.disconnectAll()
    }
    return { enabled: args.enabled }
  })

  ipcMain.handle('peerClient:getHostNames', () => ({
    names: store.getSettings().peerCollabHostNames ?? {}
  }))

  // Why: an empty name clears the alias so the endpoint shows again.
  ipcMain.handle('peerClient:setHostName', (_event, args: { hostId: string; name: string }) => {
    const names = { ...store.getSettings().peerCollabHostNames }
    const trimmed = args.name.trim()
    if (trimmed) {
      names[args.hostId] = trimmed
    } else {
      delete names[args.hostId]
    }
    store.updateSettings({ peerCollabHostNames: names })
    return { names }
  })

  ipcMain.handle('peerClient:listSavedPairings', () =>
    savedPairingCodes(store)
      .map((code) => {
        const offer = parsePairingCode(code)
        return offer ? { hostId: offer.publicKeyB64, endpoint: offer.endpoint } : null
      })
      .filter((entry): entry is { hostId: string; endpoint: string } => entry !== null)
  )

  ipcMain.handle('peerClient:forgetSavedPairing', (_event, args: { hostId: string }) => {
    const remaining = savedPairingCodes(store).filter(
      (code) => hostIdForPairingCode(code) !== args.hostId
    )
    // Why: the legacy single-slot field is fully migrated on first write to
    // the array, so any forget clears it too rather than leaving it stale.
    store.updateSettings({
      peerCollabSavedPairings: remaining,
      peerCollabSavedPairingCode: undefined
    })
    return { ok: true }
  })

  ipcMain.handle(
    'peerClient:connectSaved',
    (_event, args: { hostId: string }): PeerClientManagerConnectResult => {
      if (store.getSettings().peerCollabClientEnabled !== true) {
        return { ok: false, reason: 'client_disabled' }
      }
      const savedCode = savedPairingCodes(store).find(
        (code) => hostIdForPairingCode(code) === args.hostId
      )
      if (!savedCode) {
        return { ok: false, reason: 'no_saved_pairing' }
      }
      const displayName =
        store.getSettings().peerCollabDisplayName || resolveDefaultPeerDisplayName()
      const result = manager.connect(savedCode, displayName)
      if (result.ok) {
        pendingPairingCodes.set(result.hostId, savedCode)
      }
      return result
    }
  )

  ipcMain.handle('peerClient:getStatuses', (): PeerClientStatusWithHost[] => manager.getStatuses())

  ipcMain.handle('peerClient:listHostTerminals', async (_event, args: { hostId: string }) => {
    const service = manager.getService(args.hostId)
    if (!service) {
      return { ok: false as const, reason: 'host_not_found' }
    }
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
    (event, args: { hostId: string; terminal: string; cols: number; rows: number }) => {
      const service = manager.getService(args.hostId)
      if (!service) {
        return { ok: false as const, reason: 'host_not_found' }
      }
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
        terminalHosts.set(requestId, args.hostId)
      }
      return result
    }
  )

  ipcMain.handle('peerClient:unsubscribeTerminal', (_event, args: { requestId: string }) => {
    const hostId = terminalHosts.get(args.requestId)
    manager.getService(hostId ?? '')?.unsubscribeTerminal(args.requestId)
    terminalHosts.delete(args.requestId)
    return { ok: true }
  })

  ipcMain.handle('peerClient:getClientId', (_event, args: { hostId: string }) => ({
    clientId: manager.getService(args.hostId)?.getClientId() ?? null
  }))

  ipcMain.handle(
    'peerClient:subscribePresence',
    (event, args: { hostId: string; terminal: string }) => {
      const service = manager.getService(args.hostId)
      if (!service) {
        return { ok: false as const, reason: 'host_not_found' }
      }
      const sender = event.sender
      let requestId: string | null = null
      const result = service.subscribePresence(
        args.terminal,
        (presenceEvent: PeerPresenceEvent) => {
          if (requestId && !sender.isDestroyed()) {
            sender.send('peerClient:presenceEvent', { requestId, event: presenceEvent })
          }
        }
      )
      if (result.ok) {
        requestId = result.requestId
        presenceHosts.set(requestId, args.hostId)
      }
      return result
    }
  )

  ipcMain.handle('peerClient:unsubscribePresence', (_event, args: { requestId: string }) => {
    const hostId = presenceHosts.get(args.requestId)
    manager.getService(hostId ?? '')?.unsubscribePresence(args.requestId)
    presenceHosts.delete(args.requestId)
    return { ok: true }
  })

  ipcMain.handle(
    'peerClient:sendPresenceState',
    (_event, args: { hostId: string; terminal: string; state: PeerPresenceState }) => {
      manager.getService(args.hostId)?.sendPresenceState(args.terminal, args.state)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'peerClient:listTerminalSubscribers',
    async (_event, args: { hostId: string; terminal: string }) => {
      const service = manager.getService(args.hostId)
      if (!service) {
        return { ok: false as const, reason: 'host_not_found' }
      }
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
    (_event, args: { requestId: string; data: string }) => {
      const hostId = terminalHosts.get(args.requestId)
      const service = hostId ? manager.getService(hostId) : undefined
      return { ok: service ? service.sendTerminalInput(args.requestId, args.data) : false }
    }
  )

  ipcMain.handle(
    'peerClient:resizeTerminalStream',
    (_event, args: { requestId: string; cols: number; rows: number }) => {
      const hostId = terminalHosts.get(args.requestId)
      const service = hostId ? manager.getService(hostId) : undefined
      return {
        ok: service ? service.resizeTerminalStream(args.requestId, args.cols, args.rows) : false
      }
    }
  )

  ipcMain.handle(
    'peerClient:setTerminalStreamHidden',
    (_event, args: { requestId: string; hidden: boolean }) => {
      const hostId = terminalHosts.get(args.requestId)
      const service = hostId ? manager.getService(hostId) : undefined
      return {
        ok: service ? service.setTerminalStreamHidden(args.requestId, args.hidden) : false
      }
    }
  )

  manager.onStatusChange((hostId, status) => {
    if (status.state === 'connected') {
      const pendingCode = pendingPairingCodes.get(hostId)
      if (pendingCode) {
        store.updateSettings({
          peerCollabSavedPairings: upsertSavedPeerPairing(savedPairingCodes(store), pendingCode)
        })
        pendingPairingCodes.delete(hostId)
      }
    } else if (status.state === 'closed') {
      pendingPairingCodes.delete(hostId)
      // Why: a host that disconnects without the renderer unsubscribing
      // first would otherwise leak entries here for the life of the process.
      for (const [requestId, entryHostId] of terminalHosts) {
        if (entryHostId === hostId) {
          terminalHosts.delete(requestId)
        }
      }
      for (const [requestId, entryHostId] of presenceHosts) {
        if (entryHostId === hostId) {
          presenceHosts.delete(requestId)
        }
      }
    }
    const payload: PeerClientStatusWithHost = { hostId, ...status }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('peerClient:statusChanged', payload)
      }
    }
  })
}
