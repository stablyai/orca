import { app, powerMonitor } from 'electron'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { publishDesktopRelayStatus } from './main-process-relay-status'
import { DesktopRelayService } from '../runtime/relay/desktop-relay-service'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { mainProcessState as state } from './main-process-state'

export async function startDesktopRelayService(runtimeRpc: OrcaRuntimeRpcServer): Promise<void> {
  // Why: the request guard already holds fetchers until the proxy lands, so this only orders the launch phase ahead of the relay.
  await state.initialProxyApplicationReady
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
    // Why: sleeping past relay-token expiry kills the broker with no retry timer; resume is when that state becomes recoverable.
    powerMonitor.on('resume', () => state.desktopRelayService?.ensureLive())
  } catch (error) {
    console.warn(
      '[relay] Desktop relay startup unavailable:',
      error instanceof Error ? error.message : String(error)
    )
  }
}
