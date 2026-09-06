import { ipcRenderer } from 'electron'
import type { MobileRelayStatus } from '../../shared/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { MobileRelayMintFailure } from '../../shared/mobile-relay-mint-failure'
import type { PreloadApi } from '../api-types'

export const mobileApi = {
  listNetworkInterfaces: (): Promise<{
    interfaces: { name: string; address: string; hasDefaultRoute?: boolean }[]
  }> => ipcRenderer.invoke('mobile:listNetworkInterfaces'),

  getPairingQR: (args?: {
    address?: string
    connectionMode?: MobilePairingConnectionMode
    rotate?: boolean
  }): Promise<
    | {
        available: false
        reason?: string
        guidance?: string
        relayFailure?: MobileRelayMintFailure
      }
    | {
        available: true
        qrDataUrl: string | null
        /** Natural bitmap width and height in pixels. */
        qrSize: number | null
        qrError?: 'encoding_failed'
        pairingUrl: string
        /** Null when no direct address was advertised — the QR pairs over Relay alone. */
        endpoint: string | null
        deviceId: string
        connectionMode: MobilePairingConnectionMode
      }
  > => ipcRenderer.invoke('mobile:getPairingQR', args),

  getWindowsFirewallStatus: (args?: { address?: string }) =>
    ipcRenderer.invoke('mobile:getWindowsFirewallStatus', args),

  repairWindowsFirewall: () => ipcRenderer.invoke('mobile:repairWindowsFirewall'),

  openWindowsNetworkSettings: () => ipcRenderer.invoke('mobile:openWindowsNetworkSettings'),

  getRuntimePairingUrl: (args?: {
    address?: string
    rotate?: boolean
    // Why: the widen is one-way and host-wide, so main must gate it on the reach the user picked, not
    // on how the typed address happens to look (a Custom loopback may front an SSH tunnel).
    reach?: RuntimePairingReach
  }): Promise<
    | { available: false; reason?: 'network_exposure_failed'; guidance?: string }
    | {
        available: true
        pairingUrl: string
        webClientUrl: string | null
        endpoint: string
        deviceId: string
      }
  > => ipcRenderer.invoke('mobile:getRuntimePairingUrl', args),

  listDevices: (): Promise<{
    devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
  }> => ipcRenderer.invoke('mobile:listDevices'),

  revokeDevice: (args: { deviceId: string }): Promise<{ revoked: boolean }> =>
    ipcRenderer.invoke('mobile:revokeDevice', args),

  listRuntimeAccessGrants: () => ipcRenderer.invoke('mobile:listRuntimeAccessGrants'),

  revokeRuntimeAccess: (args: { deviceId: string }): Promise<{ revoked: boolean }> =>
    ipcRenderer.invoke('mobile:revokeRuntimeAccess', args),

  isWebSocketReady: (): Promise<{ ready: boolean; endpoint: string | null }> =>
    ipcRenderer.invoke('mobile:isWebSocketReady'),

  getRelayStatus: (): Promise<{ status: MobileRelayStatus }> =>
    ipcRenderer.invoke('mobile:getRelayStatus'),

  onRelayStatusChanged: (callback: (status: MobileRelayStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: MobileRelayStatus) =>
      callback(status)
    ipcRenderer.on('mobile:relayStatusChanged', listener)
    return () => ipcRenderer.removeListener('mobile:relayStatusChanged', listener)
  },

  consumePendingUnpairedDeviceAuthFailure: (): Promise<boolean> =>
    ipcRenderer.invoke('mobile:consumePendingUnpairedDeviceAuthFailure'),

  /** Fires (throttled, once per session) when an unpaired phone repeatedly fails direct-transport auth. */
  onUnpairedDeviceAuthFailure: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('mobile:unpairedDeviceAuthFailure', listener)
    return () => ipcRenderer.removeListener('mobile:unpairedDeviceAuthFailure', listener)
  }
} satisfies PreloadApi['mobile']
