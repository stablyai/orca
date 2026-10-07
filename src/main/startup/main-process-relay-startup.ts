import { app, powerMonitor } from 'electron'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { DesktopRelayService } from '../runtime/relay/desktop-relay-service'
import { publishDesktopRelayStatus } from './main-process-relay-status'
import { mainProcessState as state } from './main-process-state'

/** Shared by the desktop shell and `orca serve --relay`; must run after `runtimeRpc.start()`. */
export function startDesktopRelayService(runtimeRpc: OrcaRuntimeRpcServer): void {
  const cloudAuth = getOrcaCloudAuthConfig()
  if (!cloudAuth.configured) {
    return
  }
  try {
    const relayService = new DesktopRelayService({
      authConfig: cloudAuth.config,
      userDataPath: getProfileUserDataPath(),
      appVersion: app.getVersion(),
      runtimeRpc,
      onStatus: publishDesktopRelayStatus
    })
    state.desktopRelayService = relayService
    runtimeRpc.setMobileRelayPairingProvider({
      createPairingRelay: (relayDeviceId) => relayService.createPairingRelay(relayDeviceId),
      onDeviceRevokeQueued: (item) => relayService.onDeviceRevokeQueued(item),
      onDemandStateChanged: () => relayService.demandStateChanged(),
      getEndpoints: (context, params) => relayService.getEndpoints(context, params),
      provisionRelay: (context, params) => relayService.provisionRelay(context, params)
    })
    relayService.start()
    // Why: sleeping past relay-token expiry kills the broker with no retry
    // timer; resume is the moment that state becomes recoverable.
    powerMonitor.on('resume', () => state.desktopRelayService?.ensureLive())
  } catch (error) {
    console.warn(
      '[relay] Desktop relay startup unavailable:',
      error instanceof Error ? error.message : String(error)
    )
  }
}
