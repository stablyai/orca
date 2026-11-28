import { ipcMain } from 'electron'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import type { MobileRelayStatusDetail } from '../../shared/remote-runtime/relay/mobile-relay-status'
import { registerLazyIpcHandleGroup } from './lazy-ipc-handle-group'

const LAZY_MOBILE_CHANNELS = [
  'mobile:listNetworkInterfaces',
  'mobile:getPairingQR',
  'mobile:getRuntimePairingUrl',
  'mobile:listDevices',
  'mobile:listRuntimeAccessGrants',
  'mobile:revokeDevice',
  'mobile:revokeRuntimeAccess',
  'mobile:getWindowsFirewallStatus',
  'mobile:repairWindowsFirewall',
  'mobile:openWindowsNetworkSettings',
  'mobile:getRelayStatus'
] as const

export function registerLazyMobileHandlers(
  rpcServer: OrcaRuntimeRpcServer,
  dependencies: {
    getRelayStatus: () => MobileRelayStatusDetail
    consumePendingUnpairedDeviceAuthFailure: (webContentsId: number) => boolean
  }
): void {
  ipcMain.handle('mobile:consumePendingUnpairedDeviceAuthFailure', (event) => {
    if (event.sender.isDestroyed() || event.sender.getType() !== 'window') {
      return false
    }
    return dependencies.consumePendingUnpairedDeviceAuthFailure(event.sender.id)
  })
  registerLazyIpcHandleGroup(LAZY_MOBILE_CHANNELS, async (ipc) => {
    const { registerMobileHandlers } = await import('./mobile')
    registerMobileHandlers(rpcServer, { getRelayStatus: dependencies.getRelayStatus }, ipc)
  })
}
