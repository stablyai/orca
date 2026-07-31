import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { updateHostLastGoodEndpoint } from './host-store'
import { createPendingRpcClient } from './pending-rpc-client'
import {
  hasAuthoritativeMobileRouteOrder,
  orderedHostAccessRoutes
} from './mobile-access-route-order'

function directDialUrls(host: HostProfile): string[] {
  const fromOverlay =
    host.endpoints?.filter(({ kind }) => kind !== 'relay').map(({ url }) => url) ?? []
  return [...new Set([host.endpoint, ...fromOverlay])]
}

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  if (Platform.OS !== 'web' && hasAuthoritativeMobileRouteOrder(host)) {
    const firstRoute = orderedHostAccessRoutes(host)[0]
    const logical = createStableLogicalRpcClient(
      createPendingRpcClient(),
      firstRoute?.kind === 'relay'
        ? 'relay'
        : directPathForEndpoint(host, firstRoute?.url ?? host.endpoint)
    )
    attachEndpointLifecycle(logical, host, onLog)
    return logical
  }
  // Why: unmarked profiles keep the released direct/Relay startup behavior;
  // only explicit ordered profiles enter through the route supervisor above.
  let logical: ReturnType<typeof createStableLogicalRpcClient> | null = null
  const physical = connect(host.endpoint, host.deviceToken, host.publicKeyB64, {
    onLog,
    endpoints: directDialUrls(host),
    lastGoodEndpoint: host.lastGoodEndpoint,
    onDialSuccess: (endpoint) => {
      logical?.setActivePath(directPathForEndpoint(host, endpoint))
      void updateHostLastGoodEndpoint(host.id, endpoint)
    }
  })
  logical = createStableLogicalRpcClient(physical, directPathForEndpoint(host, host.endpoint))
  if (Platform.OS === 'web') {
    return logical
  }

  attachEndpointLifecycle(logical, host, onLog)
  return logical
}

function attachEndpointLifecycle(
  logical: ReturnType<typeof createStableLogicalRpcClient>,
  host: HostProfile,
  onLog: ConnectionLogSink
): void {
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
}
