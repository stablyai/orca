import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { DeviceEntry } from '../runtime/device-registry'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../runtime/network-exposure-guidance'
import {
  getDefaultPairingAddress,
  getPairingNetworkInterfaces,
  type DefaultRouteInterfaceLookup,
  type NetworkInterface
} from '../runtime/pairing-network-interfaces'
import { resolveAdvertisedPairingHostname } from '../runtime/pairing-endpoint'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import type { MobileRelayStatusDetail } from '../../shared/mobile-relay-status'
import { encodeMobilePairingQr, type MobilePairingQrResult } from '../runtime/mobile-pairing-qr'
import { getWindowsDefaultRouteInterfaceNames } from '../runtime/windows-default-route-interfaces'
import {
  getWebSocketPort,
  inspectWindowsMobileFirewall,
  repairWindowsMobileFirewall,
  type WindowsMobileFirewallEnvironment
} from '../runtime/windows-mobile-firewall'

// Only explicit this-computer intent plus a loopback address avoids widening; custom tunnel endpoints still need remote reach.
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

export type MobileHandlerDependencies = {
  firewallEnvironment?: WindowsMobileFirewallEnvironment
  openWindowsNetworkSettings?: () => Promise<void>
  getRelayStatus?: () => MobileRelayStatusDetail
  consumePendingUnpairedDeviceAuthFailure?: (webContentsId: number) => boolean
  encodePairingQr?: (pairingUrl: string) => Promise<MobilePairingQrResult>
  getDefaultRouteInterfaceNames?: DefaultRouteInterfaceLookup
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
  const getDefaultRouteInterfaceNames =
    dependencies.getDefaultRouteInterfaceNames ?? getWindowsDefaultRouteInterfaceNames
  ipcMain.handle(
    'mobile:listNetworkInterfaces',
    async (): Promise<{ interfaces: NetworkInterface[] }> => ({
      interfaces: await getPairingNetworkInterfaces(
        rpcServer.getNetworkExposureBindHost(),
        getDefaultRouteInterfaceNames
      )
    })
  )

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
      // Explicit interfaces support overlay networks unreachable through the default LAN candidate.
      const ip =
        args?.address ??
        (await getDefaultPairingAddress(
          rpcServer.getNetworkExposureBindHost(),
          getDefaultRouteInterfaceNames
        ))
      // Relay works without a direct candidate; LAN-only must refuse when none is usable.
      if (!ip && args?.connectionMode === 'local-only') {
        return {
          available: false as const,
          reason: 'invalid_advertised_endpoint',
          guidance:
            'No reachable network address is available for pairing. Connect to Wi‑Fi or Tailscale, or pick an address manually.'
        }
      }

      // Reuse never-scanned tokens until explicit rotation; authenticated entries remain independent.
      const offer = await rpcServer.createMobilePairingOffer({
        address: ip,
        connectionMode: args?.connectionMode,
        rotate: args?.rotate,
        name: `Mobile ${new Date().toLocaleDateString()}`
      })
      if (!offer.available) {
        // Preserve relay mint failures instead of silently presenting a LAN offer under the Relay label.
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
        qrSize: qr.ok ? qr.qrSize : null,
        ...(!qr.ok ? { qrError: qr.reason } : {}),
        pairingUrl: offer.pairingUrl,
        // Unadvertised loopback fallback points at the scanning device; omit it from UI endpoints.
        endpoint: ip ? offer.endpoint : null,
        deviceId: offer.deviceId,
        connectionMode: offer.connectionMode
      }
    }
  )

  ipcMain.handle(
    'mobile:getRuntimePairingUrl',
    async (_event, args?: { address?: string; rotate?: boolean; reach?: RuntimePairingReach }) => {
      const ip =
        args?.address ??
        (await getDefaultPairingAddress(
          rpcServer.getNetworkExposureBindHost(),
          getDefaultRouteInterfaceNames
        ))
      if (!ip) {
        return { available: false as const }
      }

      // Widen before advertising remote reach; this-computer intent must not trigger the irreversible widening (STA-2370).
      const thisComputerOnly = servesThisComputerOnly(args?.reach, ip)
      if (!thisComputerOnly) {
        try {
          await rpcServer.ensureNetworkExposure()
        } catch (error) {
          console.error(
            '[mobile] Network exposure failed while creating a runtime pairing offer:',
            error
          )
          // Preserve actionable widening failure guidance rather than generic unavailability.
          return {
            available: false as const,
            reason: 'network_exposure_failed' as const,
            guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
          }
        }
      }

      // Web/desktop runtime clients need full access instead of the phone allow-list.
      const offer = rpcServer.createPairingOffer({
        address: ip,
        rotate: args?.rotate,
        name: `Runtime ${new Date().toLocaleDateString()}`,
        scope: 'runtime',
        // Persist local reach so local authentication cannot expose the next launch to the LAN.
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
    // Never-scanned QR tokens are not paired devices.
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
    // Runtime links are bearer credentials immediately, so unconnected grants must remain revocable.
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

  ipcMain.handle('mobile:getWindowsFirewallStatus', (_event, args?: { address?: string }) => {
    const port = getWebSocketPort(rpcServer.getWebSocketEndpoint())
    return inspectWindowsMobileFirewall(port, args?.address, firewallEnvironment)
  })

  ipcMain.handle('mobile:repairWindowsFirewall', (event: IpcMainInvokeEvent) => {
    if (!isWindowRenderer(event)) {
      return { ok: false as const, reason: 'unsupported' as const }
    }
    // Firewall repair derives privileged inputs from runtime state, never renderer payloads.
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

  ipcMain.handle(
    'mobile:getRelayStatus',
    (): MobileRelayStatusDetail => dependencies.getRelayStatus?.() ?? { status: 'offline' }
  )

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
