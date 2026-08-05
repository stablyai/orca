import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { RpcApplicationResponsiveness } from './rpc-application-responsiveness'

export function openHostLogicalClient(
  host: HostProfile,
  onLog: ConnectionLogSink,
  onHostUpdated: (host: HostProfile, sourceRevision?: number) => void = () => {},
  applicationResponsiveness = new RpcApplicationResponsiveness()
): RpcClient {
  // Why: the stable facade owns app-visible RPC/subscription state while the
  // direct socket remains a replaceable first physical generation.
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, {
      onLog,
      applicationResponsiveness
    }),
    directPathForEndpoint(host, host.endpoint)
  )
  if (Platform.OS === 'web') {
    return logical
  }

  const endpointLifecycle = startMobileEndpointLifecycle(
    logical,
    host,
    onLog,
    onHostUpdated,
    applicationResponsiveness
  )
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
  logical.notifyForeground = (reason = 'focus') => {
    // Why: a nudge while already foreground must not re-enter setForeground —
    // that path suspended healthy relays; the supervisor probes or replaces instead.
    endpointLifecycle.nudge(reason)
    notifyLogicalForeground(reason)
  }
  return logical
}
