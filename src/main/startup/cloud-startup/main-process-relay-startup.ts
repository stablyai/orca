import { app, powerMonitor } from 'electron'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeRpcServer } from '../../runtime/rpc/server/runtime-rpc'
import { installRelayHost } from '../../runtime/mobile-cloud-relay/relay-host-install'
import { publishDesktopRelayStatus } from './main-process-relay-status'
import { mainProcessState as state } from '../main-process-state'

/**
 * The desktop's or Electron `orca serve`'s relay, as this process's own Orca account, so phones
 * reach it without a direct path. Register before proxy readiness; the install waits for it.
 */
export function startMainProcessRelayService(runtimeRpc: OrcaRuntimeRpcServer): void {
  state.core.relayHost = installRelayHost({
    runtimeRpc,
    userDataPath: getProfileUserDataPath(),
    appVersion: app.getVersion(),
    whenNetworkReady: state.initialProxyApplicationReady,
    isFenced: () => state.isQuitting,
    onStatus: publishDesktopRelayStatus
  })
  powerMonitor.on('resume', () => state.core.relayHost?.ensureLive())
}
