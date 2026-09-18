import { app, powerMonitor } from 'electron'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { publishDesktopRelayStatus } from './main-process-relay-status'
import { DesktopRelayService } from '../runtime/relay/desktop-relay-service'
import { mainProcessState as state } from './main-process-state'

// Desktop-mode relay bring-up; a no-op when cloud auth is not configured.
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
      hostMobilePairingConnectionMode: () =>
        state.store?.getSettings().mobilePairingConnectionMode ?? 'automatic',
      onStatus: publishDesktopRelayStatus
    })
    state.desktopRelayService = relayService
    // Wake signal only; the store already filters no-op writes, and the
    // decision is pulled through hostMobilePairingConnectionMode.
    state.store?.onSettingsChanged((updates) => {
      if ('mobilePairingConnectionMode' in updates) {
        state.desktopRelayService?.pairingPolicyChanged()
      }
    })
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
