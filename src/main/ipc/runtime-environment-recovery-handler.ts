import { ipcMain } from 'electron'
import { retryRemoteRuntimeSharedControlConnectionsNow } from './runtime-environment-request-connections'

const RETRY_CONNECTIONS_NOW_CHANNEL = 'runtimeEnvironments:retryConnectionsNow'

export function registerRuntimeEnvironmentRecoveryHandler(): void {
  ipcMain.removeHandler(RETRY_CONNECTIONS_NOW_CHANNEL)
  ipcMain.handle(RETRY_CONNECTIONS_NOW_CHANNEL, () => {
    retryRemoteRuntimeSharedControlConnectionsNow()
  })
}
