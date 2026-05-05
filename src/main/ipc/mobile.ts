import { ipcMain } from 'electron'
import { networkInterfaces } from 'os'
import QRCode from 'qrcode'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

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
  return result
}

function getLanAddress(): string | null {
  const ifaces = getNetworkInterfaces()
  return ifaces.length > 0 ? ifaces[0]!.address : null
}

// Why: the mobile IPC handlers provide the renderer with QR code pairing data,
// device management, and WebSocket readiness status. They depend on the
// OrcaRuntimeRpcServer because it owns the device registry and TLS state.

export function registerMobileHandlers(rpcServer: OrcaRuntimeRpcServer): void {
  ipcMain.handle('mobile:listNetworkInterfaces', (): { interfaces: NetworkInterface[] } => ({
    interfaces: getNetworkInterfaces()
  }))

  ipcMain.handle('mobile:getPairingQR', async (_event, args?: { address?: string }) => {
    const rawEndpoint = rpcServer.getWebSocketEndpoint()
    const registry = rpcServer.getDeviceRegistry()
    if (!rawEndpoint || !registry) {
      return { available: false as const }
    }

    // Why: allow the caller to specify which network interface address to
    // embed in the QR code. This supports overlay networks (Tailscale,
    // ZeroTier) where the default LAN IP isn't reachable from the phone.
    const ip = args?.address ?? getLanAddress()
    if (!ip) {
      return { available: false as const }
    }
    const endpoint = rawEndpoint.replace('0.0.0.0', ip)

    const device = registry.addDevice(`Mobile ${new Date().toLocaleDateString()}`)

    const publicKeyB64 = rpcServer.getE2EEPublicKey()
    if (!publicKeyB64) {
      return { available: false as const }
    }

    const url = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: device.token,
      publicKeyB64
    })

    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256
    })

    return {
      available: true as const,
      qrDataUrl,
      endpoint,
      deviceId: device.deviceId
    }
  })

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
        .filter((d) => d.lastSeenAt > 0)
        .map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt
        }))
    }
  })

  ipcMain.handle('mobile:revokeDevice', (_event, args: { deviceId: string }) => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: registry.removeDevice(args.deviceId) }
  })

  ipcMain.handle('mobile:isWebSocketReady', () => {
    return {
      ready: rpcServer.getWebSocketEndpoint() !== null,
      endpoint: rpcServer.getWebSocketEndpoint()
    }
  })
}
