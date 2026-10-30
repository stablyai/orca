import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { isBackgroundKeepAliveActive, subscribeBackgroundKeepAlive } from './background-keep-alive'
import { startEndpointForegroundDemand } from './endpoint-foreground-demand'

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Keep app-visible RPC/subscription identity stable while replacing physical sockets.
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    directPathForEndpoint(host.endpoint)
  )
  if (Platform.OS === 'web') {
    return logical
  }

  const endpointLifecycle = startMobileEndpointLifecycle(logical, host, onLog)
  // Foreground while the app is active, or while the live agent notification keeps it running.
  const stopForegroundDemand = startEndpointForegroundDemand({
    appState: AppState,
    isKeepAliveActive: isBackgroundKeepAliveActive,
    subscribeKeepAlive: subscribeBackgroundKeepAlive,
    apply: (foreground) => endpointLifecycle.setForeground(foreground)
  })
  const closeLogical = logical.close
  logical.close = () => {
    stopForegroundDemand()
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
