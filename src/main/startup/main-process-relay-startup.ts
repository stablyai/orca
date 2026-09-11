import { app } from 'electron'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { DesktopRelayService } from '../runtime/relay/desktop-relay-service'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { publishDesktopRelayStatus } from './main-process-relay-status'
import { mainProcessState as state } from './main-process-state'

let relayRuntime: OrcaRuntimeRpcServer | null = null

export function startDesktopRelayService(runtimeRpc: OrcaRuntimeRpcServer): void {
  // Auth and pairing can arrive before startup has applied the proxy and started RPC.
  relayRuntime = runtimeRpc
  ensureDesktopRelayService()
}

export function ensureDesktopRelayService(): DesktopRelayService | null {
  if (state.isQuitting || !relayRuntime) {
    return null
  }
  if (state.desktopRelayService) {
    return state.desktopRelayService
  }
  const cloudAuth = getOrcaCloudAuthConfig()
  if (!cloudAuth.configured) {
    return null
  }

  let service: DesktopRelayService | null = null
  try {
    service = new DesktopRelayService({
      authConfig: cloudAuth.config,
      userDataPath: getProfileUserDataPath(),
      appVersion: app.getVersion(),
      runtimeRpc: relayRuntime,
      onStatus: publishDesktopRelayStatus
    })
    const relayService = service
    relayRuntime.setMobileRelayPairingProvider({
      createPairingRelay: (id) => relayService.createPairingRelay(id),
      onDeviceRevokeQueued: (item) => relayService.onDeviceRevokeQueued(item),
      onDemandStateChanged: () => relayService.demandStateChanged(),
      getEndpoints: (context, params) => relayService.getEndpoints(context, params),
      provisionRelay: (context, params) => relayService.provisionRelay(context, params)
    })
    relayService.start()
    state.desktopRelayService = relayService
    return relayService
  } catch {
    relayRuntime.setMobileRelayPairingProvider(null)
    service?.stop()
    console.warn('[relay] Desktop relay initialization failed; retry pairing to recover')
    return null
  }
}
