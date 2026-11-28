import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import { retryRemoteRuntimeSharedControlConnectionsNow } from '../connections/runtime-environment-request-connections'
import { retrySshConnectionsAfterNetworkReturn } from '../../ssh/ssh-host-sleep-reconnect'

const RETRY_CONNECTIONS_NOW_CHANNEL = 'runtimeEnvironments:retryConnectionsNow'

export function registerRuntimeEnvironmentRecoveryHandler(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler(RETRY_CONNECTIONS_NOW_CHANNEL)
  }
  ipc.handle(RETRY_CONNECTIONS_NOW_CHANNEL, () => {
    retryRemoteRuntimeSharedControlConnectionsNow()
    // Window online is main's only network-return signal, including for SSH.
    retrySshConnectionsAfterNetworkReturn()
  })
}
