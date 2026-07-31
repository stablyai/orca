import { ipcMain } from 'electron'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { encodePairingQrDataUrl } from './pairing-qr-code'
import { getDefaultPairingAddress } from './mobile'

// Why: issues pairing offers for other Orca desktops (scope 'peer'), reusing
// createPairingOffer's LAN-endpoint resolution and device registry plumbing.
// Unlike mobile:getPairingQR, there is no connectionMode argument: peer offers
// are minted via createPairingOffer directly, which never touches the relay
// provisioning path (that branch only runs from createMobilePairingOffer), so
// they are structurally local-only.
export function registerPeerCollabHandlers(
  rpcServer: OrcaRuntimeRpcServer,
  runtime: OrcaRuntimeService
): void {
  ipcMain.handle(
    'peerCollab:getPairingOffer',
    async (_event, args?: { address?: string; rotate?: boolean }) => {
      // Why: mirrors mobile:getPairingQR/getRuntimePairingUrl so an omitted address
      // still resolves to a LAN/tailnet interface instead of createPairingOffer's
      // 127.0.0.1 loopback fallback, which would mint an unreachable peer offer.
      const ip = args?.address ?? getDefaultPairingAddress()
      if (!ip) {
        return { available: false as const }
      }
      const offer = rpcServer.createPairingOffer({
        address: ip,
        rotate: args?.rotate,
        name: `Peer ${new Date().toLocaleDateString()}`,
        scope: 'peer'
      })
      if (!offer.available) {
        return { available: false as const }
      }
      const qrDataUrl = await encodePairingQrDataUrl(offer.pairingUrl)
      return {
        available: true as const,
        qrDataUrl,
        pairingUrl: offer.pairingUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId
      }
    }
  )

  ipcMain.handle('peerCollab:listConnectedClients', () => ({
    clients: rpcServer.listConnectedPeerClients()
  }))

  // Why: mirrors mobile:listDevices' paired-and-seen filter so a QR that was
  // generated but never scanned doesn't show up as an issued device.
  ipcMain.handle('peerCollab:listDevices', () => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { devices: [] }
    }
    return {
      devices: registry
        .listDevices()
        .filter((d) => d.scope === 'peer' && d.lastSeenAt > 0)
        .map((d) => ({
          deviceId: d.deviceId,
          // Why: prefer the handshake-submitted display name over the
          // pairing-offer's auto-generated "Peer <date>" label, which just
          // repeats the "Paired <date>" row already shown below it. Empty
          // when the client has never sent one; the renderer shows a
          // dedicated placeholder for that case instead of the redundant date name.
          name: d.lastConnectedName ?? '',
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt
        }))
    }
  })

  ipcMain.handle(
    'peerCollab:disconnectClient',
    (_event, args: { deviceId: string; revokeDevice?: boolean }) => {
      const disconnected = rpcServer.disconnectPeerClient(args.deviceId)
      const revoked = args.revokeDevice ? rpcServer.revokePeerDevice(args.deviceId) : false
      return { disconnected, revoked }
    }
  )

  // Why: concurrent input policy default is free input for every participant;
  // this lets the host opt into exclusive-driver blocking instead (Phase 5).
  ipcMain.handle('peerCollab:getExclusiveInputFloor', () => ({
    enabled: rpcServer.isPeerInputFloorExclusive()
  }))

  ipcMain.handle('peerCollab:setExclusiveInputFloor', (_event, args: { enabled: boolean }) => {
    rpcServer.setPeerInputFloorExclusive(args.enabled)
    return { enabled: rpcServer.isPeerInputFloorExclusive() }
  })

  // Why: host's own terminal list for the grant picker — a direct in-process
  // call (unlike peerClient:listHostTerminals, which asks a *remote* host over
  // the RPC transport because that caller is the connecting client).
  ipcMain.handle('peerCollab:listHostTerminals', async () => {
    const result = await runtime.listTerminals()
    return {
      // Why: tabId lets the renderer join against its own tab store and apply
      // resolveTerminalTabTitle for display, since t.title here is the
      // OSC/pane-driven live title rather than the tab's resolved name.
      terminals: result.terminals.map((t) => ({ handle: t.handle, title: t.title, tabId: t.tabId }))
    }
  })

  // Why: host-side control for Phase 1 grant enforcement (device-registry's
  // setGrantedTerminals); the UI calls this when the host changes which
  // terminals a paired peer device may see/use.
  ipcMain.handle(
    'peerCollab:setGrantedTerminals',
    (_event, args: { deviceId: string; handles: string[] }) => ({
      ok: rpcServer.setGrantedTerminals(args.deviceId, args.handles)
    })
  )
}
