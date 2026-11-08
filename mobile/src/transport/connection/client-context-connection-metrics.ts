import { useEffect, useState } from 'react'
import { useRpcClientContext } from './client-context'
import type { RpcClientContextValue } from './rpc-client-context-contract'
import type { RelayHostReachability } from '../relay/relay-host-reachability'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

export function useReconnectAttempt(hostId: string | undefined): number {
  return useHostMetric(hostId, (context, id) => context.getReconnectAttempt(id), 0)
}

export function useLastConnectedAt(hostId: string | undefined): number | null {
  return useHostMetric(hostId, (context, id) => context.getLastConnectedAt(id), null)
}

export function useConnectionPathStatus(hostId: string | undefined): {
  activePath: MobileConnectionPath
  pendingPath: MobileConnectionPath | null
} {
  return useHostMetric(
    hostId,
    (context, id) => ({
      activePath: context.getActivePath(id),
      pendingPath: context.getPendingPath(id)
    }),
    { activePath: 'lan', pendingPath: null }
  )
}

// Read relay recovery inputs from one subscription so screens cannot render half an escalation.
export function useRelayRecoveryStatus(hostId: string | undefined): {
  pendingPath: MobileConnectionPath | null
  pairingRejected: boolean
  relayHostReachability: RelayHostReachability
} {
  return useHostMetric(
    hostId,
    (context, id) => ({
      pendingPath: context.getPendingPath(id),
      pairingRejected: context.isPairingRejected(id),
      relayHostReachability: context.getRelayHostReachability(id)
    }),
    { pendingPath: null, pairingRejected: false, relayHostReachability: 'connecting' }
  )
}

function useHostMetric<T>(
  hostId: string | undefined,
  read: (context: RpcClientContextValue, hostId: string) => T,
  fallback: T
): T {
  const context = useRpcClientContext()
  const [, force] = useState(0)
  useEffect(() => {
    if (!hostId) {
      return
    }
    return context.subscribeHostState(hostId, () => force((count) => count + 1))
  }, [context, hostId])
  return hostId ? read(context, hostId) : fallback
}

// The inputs a screen header gives classifyConnection beside the client state, re-read on host state and path
// changes, so a view under that header shows the same steady verdict.
export function useHostConnectionInputs(hostId: string | undefined) {
  return {
    reconnectAttempts: useReconnectAttempt(hostId),
    lastConnectedAt: useLastConnectedAt(hostId),
    ...useRelayRecoveryStatus(hostId)
  }
}

export type HostConnectionInputs = ReturnType<typeof useHostConnectionInputs>
