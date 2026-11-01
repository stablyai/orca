import { ipcRenderer } from 'electron'
import type { MobileRelayStatusDetail } from '../../shared/mobile-relay-status'
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
        qrSize: number | null
        qrError?: 'encoding_failed'
        pairingUrl: string
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
    // Gate host-wide exposure on the chosen reach: a loopback address may front an SSH tunnel.
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

  getRelayStatus: (): Promise<MobileRelayStatusDetail> =>
    ipcRenderer.invoke('mobile:getRelayStatus'),

  onRelayStatusChanged: (callback: (detail: MobileRelayStatusDetail) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, detail: MobileRelayStatusDetail) =>
      callback(detail)
    ipcRenderer.on('mobile:relayStatusChanged', listener)
    return () => ipcRenderer.removeListener('mobile:relayStatusChanged', listener)
  },

  consumePendingUnpairedDeviceAuthFailure: (): Promise<boolean> =>
    ipcRenderer.invoke('mobile:consumePendingUnpairedDeviceAuthFailure'),

  onUnpairedDeviceAuthFailure: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('mobile:unpairedDeviceAuthFailure', listener)
    return () => ipcRenderer.removeListener('mobile:unpairedDeviceAuthFailure', listener)
  }
} satisfies PreloadApi['mobile']
