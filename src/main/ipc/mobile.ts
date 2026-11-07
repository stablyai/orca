import { usesLegacyE2EE } from '../runtime/rpc/server/pairing/device-sighting'
import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { RuntimeAccessGrant } from '../../shared/runtime-access-grants'
import type { MobilePairingConnectionMode } from '../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { DeviceEntry } from '../runtime/rpc/server/pairing/device-entry'
import {
  requestMobilePairingOffer,
  requestRuntimePairingOffer
} from '../runtime/pairing-offer-requests'
import {
  getPairingNetworkInterfaces,
  type DefaultRouteInterfaceLookup,
  type NetworkInterface
} from '../runtime/pairing-network-interfaces'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import type { MobileRelayStatusDetail } from '../../shared/remote-runtime/relay/mobile-relay-status'
import {
  encodeMobilePairingQr,
  type MobilePairingQrResult
} from '../runtime/rpc/server/pairing/mobile-pairing-qr'
import {
  MOBILE_PAIRING_OFFER_TTL_MS,
  RUNTIME_PAIRING_OFFER_TTL_MS
} from '../runtime/rpc/server/pairing/pairing-offer-expiry'
import { getWindowsDefaultRouteInterfaceNames } from '../runtime/windows-default-route-interfaces'
import {
  getWebSocketPort,
  inspectWindowsMobileFirewall,
  repairWindowsMobileFirewall,
  type WindowsMobileFirewallEnvironment
} from '../runtime/windows-mobile-firewall'

function toRuntimeAccessGrant(device: DeviceEntry): RuntimeAccessGrant {
  return {
    deviceId: device.deviceId,
    name: device.name,
    createdAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt > 0 ? device.lastSeenAt : null,
    usesLegacyEncryption: usesLegacyE2EE(device)
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

/**
 * Register pairing, device access and transport diagnostics IPC.
 * Iroh pairing ignores LAN address selection and uses the offer's key-based endpoint.
 */
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
      const offer = await requestMobilePairingOffer(
        rpcServer,
        {
          address: args?.address,
          connectionMode: args?.connectionMode,
          rotate: args?.rotate,
          offerTtlMs: MOBILE_PAIRING_OFFER_TTL_MS
        },
        getDefaultRouteInterfaceNames
      )
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
        endpoint: offer.endpoint,
        deviceId: offer.deviceId,
        connectionMode: offer.connectionMode,
        expiresAt: offer.offerExpiresAt
      }
    }
  )

  ipcMain.handle(
    'mobile:getRuntimePairingUrl',
    async (_event, args?: { address?: string; rotate?: boolean; reach?: RuntimePairingReach }) => {
      const offer = await requestRuntimePairingOffer(
        rpcServer,
        {
          address: args?.address,
          rotate: args?.rotate,
          reach: args?.reach,
          offerTtlMs: RUNTIME_PAIRING_OFFER_TTL_MS
        },
        getDefaultRouteInterfaceNames
      )
      if (!offer.available) {
        // Preserve actionable widening failure guidance rather than generic unavailability.
        return offer.reason === 'network_exposure_failed'
          ? { available: false as const, reason: offer.reason, guidance: offer.guidance }
          : { available: false as const }
      }

      return {
        available: true as const,
        pairingUrl: offer.pairingUrl,
        webClientUrl: offer.webClientUrl,
        endpoint: offer.endpoint,
        deviceId: offer.deviceId,
        expiresAt: offer.offerExpiresAt
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
          lastSeenAt: d.lastSeenAt,
          usesLegacyEncryption: usesLegacyE2EE(d)
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

  ipcMain.handle('mobile:getIrohStatus', () => rpcServer.getIrohStatus())

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
