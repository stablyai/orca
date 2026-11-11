import { AppState, Platform } from 'react-native'
import { processDeviceStore } from '../../device-store/device-store'
import { connect } from '../rpc/direct-rpc-connect'
import type { RpcClient } from '../rpc/rpc-client-contract'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink } from '../../diagnostics/connection/connection-log-types'
import type { HostProfile } from '../../host-catalog/host-profile'
import { directPathForEndpoint } from '../relay/mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { watchHostRevocation } from './host-revocation-watch'
import { peekEndpointAuthHeaders } from '../endpoint-auth-headers'

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Keep app-visible RPC/subscription identity stable while replacing physical sockets.
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, {
      onLog,
      edgeAuthHeaders: peekEndpointAuthHeaders(host.id, host.endpoint)
    }),
    directPathForEndpoint(host.endpoint)
  )
  if (Platform.OS === 'web') {
    return logical
  }

  const endpointLifecycle = startMobileEndpointLifecycle(logical, host, onLog)
  endpointLifecycle.setForeground(AppState.currentState === 'active')
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    endpointLifecycle.setForeground(state === 'active')
  })
  // A definite revocation (K6): cached screens go at once and stay gone until the desktop accepts this
  // phone again; drafts stay until the host is removed.
  const stopRevocationWipe = watchHostRevocation(logical, (revoked) => {
    const store = processDeviceStore()
    store.fenceHostCache(host.id, revoked)
    if (revoked) {
      void store.wipeHost(host.id, ['cache']).catch(() => undefined)
    }
  })
  const closeLogical = logical.close
  logical.close = () => {
    stopRevocationWipe()
    appStateSubscription.remove()
    endpointLifecycle.stop()
    closeLogical()
  }
  const notifyLogicalForeground = logical.notifyForeground
  logical.notifyForeground = (reason = 'focus') => {
    // Foreground nudges probe/replace; re-entering setForeground would suspend healthy relays.
    endpointLifecycle.nudge(reason)
    notifyLogicalForeground(reason)
  }
  return logical
}
