import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { networkInterfaces } from 'node:os'
import QRCode from 'qrcode'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import { isTailnetIPv4Address } from '../../shared/tailnet-address'
import type { DeviceEntry } from '../runtime/device-registry'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { RelayBrokerStatus } from '../runtime/relay/relay-session-broker'
import {
  getWebSocketPort,
  inspectWindowsMobileFirewall,
  repairWindowsMobileFirewall,
  type WindowsMobileFirewallEnvironment
} from '../runtime/windows-mobile-firewall'

export type NetworkInterface = {
  name: string
  address: string
}

// Why: the WebSocket transport advertises 0.0.0.0 as its endpoint, which isn't
// connectable from a mobile device. We enumerate all non-internal IPv4
// addresses so the user can choose which one to advertise in the QR code
// (e.g. LAN vs Tailscale).
function getNetworkInterfaces(): NetworkInterface[] {
  const result: NetworkInterface[] = []
  const interfaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) {
      continue
    }
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ name, address: addr.address })
      }
    }
  }
  return result.sort(
    (a, b) => Number(isTailnetIPv4Address(b.address)) - Number(isTailnetIPv4Address(a.address))
  )
}

function getDefaultPairingAddress(): string | null {
  const ifaces = getNetworkInterfaces()
  return ifaces.length > 0 ? ifaces[0]!.address : null
}

function toRuntimeAccessGrant(device: DeviceEntry): RuntimeAccessGrant {
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null
  }
}

// Why: the mobile IPC handlers provide the renderer with QR code pairing data,
// device management, and WebSocket readiness status. They depend on the
// OrcaRuntimeRpcServer because it owns the device registry and TLS state.

export type MobileHandlerDependencies = {
  firewallEnvironment?: WindowsMobileFirewallEnvironment
  openWindowsNetworkSettings?: () => Promise<void>
  getRelayStatus?: () => RelayBrokerStatus
}

export function registerMobileHandlers(
  rpcServer: OrcaRuntimeRpcServer,
  dependencies: MobileHandlerDependencies = {}
): void {
  const firewallEnvironment = dependencies.firewallEnvironment ?? {
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    systemRoot: process.env.SystemRoot
  }
  ipcMain.handle('mobile:listNetworkInterfaces', (): { interfaces: NetworkInterface[] } => ({
    interfaces: getNetworkInterfaces()
  }))

  ipcMain.handle(
    'mobile:getPairingQR',
    async (
      _event,
      args?: {
        address?: string
        connectionMode?: MobilePairingConnectionMode
        rotate?: boolean
      }
    ) => {
      // Why: allow the caller to specify which network interface address to
      // embed in the QR code. This supports overlay networks (Tailscale,
      // ZeroTier) where the default LAN IP isn't reachable from the phone.
      const ip = args?.address ?? getDefaultPairingAddress()
      if (!ip) {
        return { available: false as const }
      }

      // Why: coalesce repeated QR regenerations onto a single never-scanned
      // pending token so the copy-button flow doesn't accumulate orphaned
      // device credentials forever. The token graduates to a real entry when
      // a phone actually connects (lastSeenAt > 0). When the caller passes
      // `rotate: true` (explicit "Regenerate" intent because the prior token
      // may have been exposed), we discard any pending token and mint a fresh
      // one so the new QR carries a different credential.
      const offer = await rpcServer.createMobilePairingOffer({
        address: ip,
        connectionMode: args?.connectionMode,
        rotate: args?.rotate,
        name: `Mobile ${new Date().toLocaleDateString()}`
      })
      if (!offer.available) {
        return { available: false as const }
      }

      const qrDataUrl = await QRCode.toDataURL(offer.pairingUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 256
      })

      return {
        available: true as const,
        qrDataUrl,
        pairingUrl: offer.pairingUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId
      }
    }
  )

  ipcMain.handle(
    'mobile:getRuntimePairingUrl',
    async (_event, args?: { address?: string; rotate?: boolean }) => {
      const ip = args?.address ?? getDefaultPairingAddress()
      if (!ip) {
        return { available: false as const }
      }

      // Why: web/desktop runtime clients need full runtime access, not the
      // mobile allowlist used by phone QR pairing.
      const offer = rpcServer.createPairingOffer({
        address: ip,
        rotate: args?.rotate,
        name: `Runtime ${new Date().toLocaleDateString()}`,
        scope: 'runtime'
      })
      if (!offer.available) {
        return { available: false as const }
      }

      return {
        available: true as const,
        pairingUrl: offer.pairingUrl,
        webClientUrl: offer.webClientUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId
      }
    }
  )

  ipcMain.handle('mobile:listDevices', () => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { devices: [] }
    }
    // Why: devices with lastSeenAt === 0 were created during QR generation
    // but never actually scanned/connected. Showing them as "paired" is
    // misleading, so we filter them out.
    return {
      devices: registry
        .listDevices()
        .filter((d) => d.scope === 'mobile' && d.lastSeenAt > 0)
        .map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt
        }))
    }
  })

  ipcMain.handle('mobile:listRuntimeAccessGrants', () => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { grants: [] }
    }
    // Why: generated web/runtime links are bearer credentials even before a
    // client first connects, so pending runtime grants must stay revocable.
    return {
      grants: registry
        .listDevices()
        .filter((d) => d.scope === 'runtime')
        .sort((a, b) => b.pairedAt - a.pairedAt)
        .map(toRuntimeAccessGrant)
    }
  })

  ipcMain.handle('mobile:revokeDevice', async (_event, args: { deviceId: string }) => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: await rpcServer.revokeMobileDevice(args.deviceId) }
  })

  ipcMain.handle('mobile:revokeRuntimeAccess', (_event, args: { deviceId: string }) => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: rpcServer.revokeRuntimeAccess(args.deviceId) }
  })

  ipcMain.handle('mobile:isWebSocketReady', () => {
    return {
      ready: rpcServer.getWebSocketEndpoint() !== null,
      endpoint: rpcServer.getWebSocketEndpoint()
    }
  })

  ipcMain.handle('mobile:getWindowsFirewallStatus', (_event, args?: { address?: string }) => {
    const port = getWebSocketPort(rpcServer.getWebSocketEndpoint())
    return inspectWindowsMobileFirewall(port, args?.address, firewallEnvironment)
  })

  ipcMain.handle('mobile:repairWindowsFirewall', (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event)) {
      return { ok: false as const, reason: 'unsupported' as const }
    }
    // Why: elevated inputs come from the running runtime, never the renderer.
    const port = getWebSocketPort(rpcServer.getWebSocketEndpoint())
    return repairWindowsMobileFirewall(port, firewallEnvironment)
  })

  ipcMain.handle('mobile:openWindowsNetworkSettings', async (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event) || firewallEnvironment.platform !== 'win32') {
      return false
    }
    const openSettings =
      dependencies.openWindowsNetworkSettings ??
      (() => shell.openExternal('ms-settings:network-status'))
    await openSettings()
    return true
  })

  ipcMain.handle('mobile:getRelayStatus', () => ({
    status: dependencies.getRelayStatus?.() ?? 'offline'
  }))
}

function isWindowRenderer(event: IpcMainInvokeEvent): boolean {
  return !event.sender.isDestroyed() && event.sender.getType() === 'window'
}
