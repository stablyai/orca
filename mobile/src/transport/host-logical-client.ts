import { AppState, Platform } from 'react-native'
import { connect, type RpcClient } from './rpc-client'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionLogSink, HostProfile } from './types'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import { startMobileEndpointLifecycle } from './mobile-endpoint-lifecycle'
import { openIrohRpcClient } from './mobile-iroh-physical-link'
import { hostHasIrohEndpoint, inferIrohPathMode } from './mobile-iroh-availability'
import { setIrohHostStatus } from './mobile-iroh-host-status'

export function openHostLogicalClient(host: HostProfile, onLog: ConnectionLogSink): RpcClient {
  // Why: iroh pairings dial ONLY iroh — it discovers LAN paths itself (local
  // direct addrs), so a ws:// leg would just add noise and a dead dial
  // off-network. The ws generation remains for hosts paired without iroh.
  if (hostHasIrohEndpoint(host) && inferIrohPathMode(host) === 'primary-off-lan') {
    const irohClient = openIrohRpcClient({
      desktopEndpointId: host.iroh!.endpointId,
      ...(host.iroh!.relayUrl || host.iroh!.directAddresses
        ? {
            dialHints: {
              ...(host.iroh!.relayUrl ? { relayUrl: host.iroh!.relayUrl } : {}),
              ...(host.iroh!.directAddresses ? { directAddresses: host.iroh!.directAddresses } : {})
            }
          }
        : {}),
      deviceToken: host.deviceToken,
      publicKeyB64: host.publicKeyB64,
      onLog
    })
    if (irohClient) {
      console.log('[iroh]', 'native_primary', { hostId: host.id })
      setIrohHostStatus(host.id, 'attempting', 'native_primary', Date.now())
      const logical = createStableLogicalRpcClient(irohClient, 'iroh')
      return finalizeLogicalClient(logical, host, onLog)
    }
    // Native module unavailable — fall through to the ws generation.
    console.log('[iroh]', 'native_primary_unavailable_fallback_ws', { hostId: host.id })
    setIrohHostStatus(host.id, 'failed', 'native_module_unavailable', Date.now())
  }

  // Why: the stable facade owns app-visible RPC/subscription state while the
  // direct socket remains a replaceable first physical generation.
  const logical = createStableLogicalRpcClient(
    connect(host.endpoint, host.deviceToken, host.publicKeyB64, { onLog }),
    directPathForEndpoint(host, host.endpoint)
  )
  if (Platform.OS === 'web') {
    return logical
  }
  return finalizeLogicalClient(logical, host, onLog)
}

// Why: supervisor lifecycle (foreground revival, recovery, teardown) is
// identical for iroh-native and legacy first generations.
function finalizeLogicalClient(
  logical: ReturnType<typeof createStableLogicalRpcClient>,
  host: HostProfile,
  onLog: ConnectionLogSink
): RpcClient {
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
  logical.notifyForeground = (reason = 'focus') => {
    // Why: a nudge while already foreground must not re-enter setForeground —
    // that path suspended healthy relays; the supervisor probes or replaces instead.
    endpointLifecycle.nudge(reason)
    notifyLogicalForeground(reason)
  }
  return logical
}
