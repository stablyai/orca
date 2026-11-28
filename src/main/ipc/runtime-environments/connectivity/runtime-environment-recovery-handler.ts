import { ipcMain } from 'electron'
import { retryRemoteRuntimeSharedControlConnectionsNow } from '../connections/runtime-environment-request-connections'
import { clearRelayDialHolds } from '../connections/runtime-environment-relay-link'
import { retrySshConnectionsAfterNetworkReturn } from '../../ssh/ssh-host-sleep-reconnect'

const RETRY_CONNECTIONS_NOW_CHANNEL = 'runtimeEnvironments:retryConnectionsNow'

export function registerRuntimeEnvironmentRecoveryHandler(): void {
  ipcMain.removeHandler(RETRY_CONNECTIONS_NOW_CHANNEL)
  ipcMain.handle(RETRY_CONNECTIONS_NOW_CHANNEL, () => {
    // OS wake or network return: a Relay host held offline is dialed now too.
    clearRelayDialHolds()
    retryRemoteRuntimeSharedControlConnectionsNow()
    // Window online is main's only network-return signal, including for SSH.
    retrySshConnectionsAfterNetworkReturn()
  })
}
