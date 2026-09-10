import { HostProtocolAdmission } from './host-protocol-admission'
import { attachHostProtocolVerification } from './host-protocol-verifier'
import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Why: the stable facade owns app-visible RPC/subscription state while the
  // direct socket remains a replaceable first physical generation.
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    directPathForEndpoint(host, host.endpoint),
    new HostProtocolAdmission()
  )
  // Why: admission gates every screen but the gate component only mounts under /h/, so the
  // client — not a route — owns the probe that opens it, on connect and on every cutover.
  const client = attachHostProtocolVerification(logical, host.id)
  if (Platform.OS === 'web') {
    return client
  }

  const endpointLifecycle = startMobileEndpointLifecycle(client, host, onLog)
  endpointLifecycle.setForeground(AppState.currentState === 'active')
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    endpointLifecycle.setForeground(state === 'active')
  })
  const closeLogical = client.close
  client.close = () => {
    appStateSubscription.remove()
    endpointLifecycle.stop()
    closeLogical()
  }
  const notifyLogicalForeground = client.notifyForeground
  client.notifyForeground = (reason = 'focus') => {
    // Why: a nudge while already foreground must not re-enter setForeground —
    // that path suspended healthy relays; the supervisor probes or replaces instead.
    endpointLifecycle.nudge(reason)
    notifyLogicalForeground(reason)
  }
  return client
}
