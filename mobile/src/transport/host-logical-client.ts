import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { updateHostLastGoodEndpoint } from './host-store'

function directDialUrls(host: HostProfile): string[] {
  const fromOverlay =
    host.endpoints?.filter(({ kind }) => kind !== 'relay').map(({ url }) => url) ?? []
  return [...new Set([host.endpoint, ...fromOverlay])]
}

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Why: ordered direct endpoints (Tailscale then LAN) come from the pairing
  // overlay; sticky last-good is separate from host.endpoint (KTD9).
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, {
      onLog,
      endpoints: directDialUrls(host),
      lastGoodEndpoint: host.lastGoodEndpoint,
      onDialSuccess: (endpoint) => {
        void updateHostLastGoodEndpoint(host.id, endpoint)
      }
    }),
    directPathForEndpoint(host, host.endpoint)
  )
  if (Platform.OS === 'web') {
    return logical
  }

  const endpointLifecycle = startMobileEndpointLifecycle(logical, host, onLog)
  endpointLifecycle.setForeground(AppState.currentState === 'active')
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    endpointLifecycle.setForeground(state === 'active')
  })
  const closeLogical = logical.close
  logical.close = () => {
    appStateSubscription.remove()
    endpointLifecycle.stop()
    closeLogical()
  }
  const notifyLogicalForeground = logical.notifyForeground
  logical.notifyForeground = () => {
    endpointLifecycle.setForeground(true)
    notifyLogicalForeground()
  }
  return logical
}
