import { ipcMain } from 'electron'
import { retryRemoteRuntimeSharedControlConnectionsNow } from './runtime-environment-request-connections'
import { retrySshConnectionsAfterNetworkReturn } from '../ssh/ssh-host-sleep-reconnect'

const RETRY_CONNECTIONS_NOW_CHANNEL = 'runtimeEnvironments:retryConnectionsNow'

export function registerRuntimeEnvironmentRecoveryHandler(): void {
  ipcMain.removeHandler(RETRY_CONNECTIONS_NOW_CHANNEL)
  ipcMain.handle(RETRY_CONNECTIONS_NOW_CHANNEL, () => {
    retryRemoteRuntimeSharedControlConnectionsNow()
    // Why: the window's `online` event is main's only network-return signal; SSH needs it too.
    retrySshConnectionsAfterNetworkReturn()
  })
}
