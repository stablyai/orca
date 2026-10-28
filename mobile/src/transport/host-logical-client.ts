import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import {
  backgroundReadingActive,
  subscribeBackgroundReading
} from '../speech/background-reading-state'

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
  // While the background reader runs, keep the link foreground so it survives the screen going off.
  const isForeground = (state = AppState.currentState) =>
    state === 'active' || backgroundReadingActive()
  endpointLifecycle.setForeground(isForeground())
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    endpointLifecycle.setForeground(isForeground(state))
  })
  const unsubscribeBackgroundReading = subscribeBackgroundReading(() =>
    endpointLifecycle.setForeground(isForeground())
  )
  const closeLogical = logical.close
  logical.close = () => {
    unsubscribeBackgroundReading()
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
