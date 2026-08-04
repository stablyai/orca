import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { networkInterfaces } from 'node:os'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import { isTailnetIPv4Address } from '../../shared/tailnet-address'
import type { DeviceEntry } from '../runtime/device-registry'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../runtime/network-exposure-guidance'
import { resolveAdvertisedPairingHostname } from '../runtime/pairing-endpoint'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { RelayBrokerStatus } from '../runtime/relay/relay-session-broker'
import { encodeMobilePairingQr, type MobilePairingQrResult } from '../runtime/mobile-pairing-qr'
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

// Why: link-local IPv6 addresses (fe80::/10) require a scope/zone id to be
// connectable and never work as a QR-advertised pairing host, so they are
// excluded from the pickable list. The regex covers the full /10 range
// (fe80: through febf:), not just the fe80: prefix the OS usually assigns.
function isUsableIPv6Address(address: string): boolean {
  return !/^fe[89ab][0-9a-f]:/i.test(address)
}

function isProxyFakeIpIPv4Address(address: string): boolean {
  return /^198\.(?:18|19)\./.test(address)
}

// Why: the WebSocket transport advertises 0.0.0.0 as its endpoint, which isn't
// connectable from a mobile device. We enumerate all non-internal IPv4 and
// (non-link-local) IPv6 addresses so the user can choose which one to advertise
// in the QR code (e.g. LAN vs Tailscale). IPv6 must be included so pairing works
// on IPv6-only hosts (e.g. a headless `orca serve` reachable only over IPv6),
// where an IPv4-only scan returns nothing and the UI reports "no interfaces".
function getNetworkInterfaces(): NetworkInterface[] {
  const result: NetworkInterface[] = []
  const interfaces = networkInterfaces()
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) {
      continue
    }
    for (const addr of addrs) {
      if (addr.internal) {
        continue
      }
      if (addr.family === 'IPv4') {
        // 198.18.0.0/15 proxy fake IPs are only routable inside the desktop proxy.
        if (isProxyFakeIpIPv4Address(addr.address)) {
          continue
        }
        result.push({ name, address: addr.address })
      } else if (addr.family === 'IPv6' && isUsableIPv6Address(addr.address)) {
        result.push({ name, address: addr.address })
      }
    }
  }
  // Why: prefer tailnet IPv4 first (most portable across networks), then other
  // IPv4, then IPv6 as a fallback for IPv6-only environments.
  return result.sort((a, b) => rankAddress(a.address) - rankAddress(b.address))
}

function rankAddress(address: string): number {
  if (isTailnetIPv4Address(address)) {
    return 0
  }
  return address.includes(':') ? 2 : 1
}

function getDefaultPairingAddress(): string | null {
  const ifaces = getNetworkInterfaces()
  return ifaces.length > 0 ? ifaces[0]!.address : null
}

// Why: only an explicit "This computer only" pick skips the one-way widen, and only when the address it
// advertises really is loopback — a mismatch (a LAN address under a this-computer reach) would otherwise
// mint a link with no listener behind it. Every other reach, including a loopback-looking Custom address
// that fronts an SSH tunnel or reverse proxy, still opts in.
function servesThisComputerOnly(reach: RuntimePairingReach | undefined, address: string): boolean {
  if (reach !== 'this-computer') {
    return false
  }
  const hostname = resolveAdvertisedPairingHostname(address)
  return hostname !== null && classifyRemotePairingHostname(hostname) === 'loopback'
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
  consumePendingUnpairedDeviceAuthFailure?: (webContentsId: number) => boolean
  encodePairingQr?: (pairingUrl: string) => Promise<MobilePairingQrResult>
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
        return {
          available: false as const,
          reason: 'invalid_advertised_endpoint',
          guidance:
            'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
        }
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
        // Why: surface Relay mint failures (and other pairing unavailability)
        // so the UI can refuse a silent LAN QR under the Relay label.
        return {
          available: false as const,
          reason: offer.reason,
          guidance: offer.guidance,
          ...(offer.relayFailure ? { relayFailure: offer.relayFailure } : {})
        }
      }

      const qr = await (dependencies.encodePairingQr ?? encodeMobilePairingQr)(offer.pairingUrl)

      return {
        available: true as const,
        qrDataUrl: qr.ok ? qr.qrDataUrl : null,
        ...(!qr.ok ? { qrError: qr.reason } : {}),
        pairingUrl: offer.pairingUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId,
        connectionMode: offer.connectionMode
      }
    }
  )

  ipcMain.handle(
    'mobile:getRuntimePairingUrl',
    async (_event, args?: { address?: string; rotate?: boolean; reach?: RuntimePairingReach }) => {
      const ip = args?.address ?? getDefaultPairingAddress()
      if (!ip) {
        return { available: false as const }
      }

      // Why: STA-2370 — generating a runtime pairing offer is the user's explicit opt-in to remote
      // reach, so widen the loopback listener before advertising its LAN endpoint. If the widen fails the
      // listener stays on loopback, so report unavailable rather than advertise a dead LAN endpoint.
      // "This computer only" is the opposite opt-in: the loopback listener already serves it, and the widen
      // never narrows back, so that pick alone must not expose the runtime off-host.
      const thisComputerOnly = servesThisComputerOnly(args?.reach, ip)
      if (!thisComputerOnly) {
        try {
          await rpcServer.ensureNetworkExposure()
        } catch (error) {
          console.error(
            '[mobile] Network exposure failed while creating a runtime pairing offer:',
            error
          )
          // Why: STA-2370 — carry the specific reason/guidance to the renderer (mirrors the mobile-QR path) so
          // a widen failure is distinguishable from a missing address, not collapsed into a bare unavailable.
          return {
            available: false as const,
            reason: 'network_exposure_failed' as const,
            guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
          }
        }
      }

      // Why: web/desktop runtime clients need full runtime access, not the
      // mobile allowlist used by phone QR pairing.
      const offer = rpcServer.createPairingOffer({
        address: ip,
        rotate: args?.rotate,
        name: `Runtime ${new Date().toLocaleDateString()}`,
        scope: 'runtime',
        // Why: a grant that only ever pointed at loopback must not make the next launch bind every
        // interface when its local client reconnects (that would restore the exposure one restart later).
        reach: thisComputerOnly ? 'this-computer' : 'network'
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

  ipcMain.handle('mobile:consumePendingUnpairedDeviceAuthFailure', (event) => {
    if (!isWindowRenderer(event)) {
      return false
    }
    return dependencies.consumePendingUnpairedDeviceAuthFailure?.(event.sender.id) ?? false
  })
}

function isWindowRenderer(event: IpcMainInvokeEvent): boolean {
  return !event.sender.isDestroyed() && event.sender.getType() === 'window'
}
