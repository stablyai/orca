import { AppState, Platform } from 'react-native'
import { setKeptBotsRevoked } from '../../bots/kept-server-bot-listings'
import { processDeviceStore } from '../../device-store/device-store'
import { connect } from '../rpc/direct-rpc-connect'
import type { RpcClient } from '../rpc/rpc-client-contract'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink } from '../../diagnostics/connection/connection-log-types'
import type { HostProfile } from '../../host-catalog/host-profile'
import { directPathForEndpoint } from '../relay/mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { watchHostRevocation } from './host-revocation-watch'
import {
  setHostPairingRefused,
  setHostReachesOffLan
} from '../../host-descriptors/direct-pairing-installations'
import { isTailscaleEndpoint } from '../../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import { createUndialableDirectClient, skipsDirectEndpoint } from './undialable-direct-endpoint'
import { readvertiseOnPageChange } from './mobile-runtime-capability-negotiation'

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Keep app-visible RPC/subscription identity stable while replacing physical sockets.
  // Web runs no relay supervisor, so it must keep dialing whatever endpoint it has.
  const logical = createStableLogicalRpcClient(
    Platform.OS !== 'web' && skipsDirectEndpoint(host)
      ? createUndialableDirectClient()
      : connect(host.endpoint, host.deviceToken, host.publicKeyB64, { onLog, hostId: host.id }),
    directPathForEndpoint(host.endpoint)
  )
  if (Platform.OS === 'web') {
    return logical
  }

  setHostReachesOffLan(host.id, host.relay !== undefined || isTailscaleEndpoint(host.endpoint))
  const endpointLifecycle = startMobileEndpointLifecycle(logical, host, onLog)
  endpointLifecycle.setForeground(AppState.currentState === 'active')
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    endpointLifecycle.setForeground(state === 'active')
  })
  // A definite revocation (K6): cached screens go at once and stay gone until the desktop accepts this
  // phone again; drafts stay until the host is removed.
  const stopPageCapabilities = readvertiseOnPageChange(host.id, logical)
  const stopRevocationWipe = watchHostRevocation(logical, (revoked) => {
    const store = processDeviceStore()
    store.fenceHostCache(host.id, revoked)
    setKeptBotsRevoked(host.id, revoked)
    setHostPairingRefused(host.id, revoked)
    if (revoked) {
      void store.wipeHost(host.id, ['cache']).catch(() => undefined)
    }
  })
  const closeLogical = logical.close
  logical.close = () => {
    stopRevocationWipe()
    stopPageCapabilities()
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
