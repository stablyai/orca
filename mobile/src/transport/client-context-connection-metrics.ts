import { useEffect, useState } from 'react'
import { useRpcClientContext, type RpcClientContextValue } from './client-context'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

export function useReconnectAttempt(hostId: string | undefined): number {
  return useHostMetric(hostId, (context, id) => context.getReconnectAttempt(id), 0)
}

export function useLastConnectedAt(hostId: string | undefined): number | null {
  return useHostMetric(hostId, (context, id) => context.getLastConnectedAt(id), null)
}

// Both inputs classifyConnection needs about a relay recovery, read from one
// subscription so a screen cannot render half of the escalation.
export function useRelayRecoveryStatus(hostId: string | undefined): {
  pendingPath: MobileConnectionPath | null
  pairingRejected: boolean
} {
  return useHostMetric(
    hostId,
    (context, id) => ({
      pendingPath: context.getPendingPath(id),
      pairingRejected: context.isPairingRejected(id)
    }),
    { pendingPath: null, pairingRejected: false }
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
