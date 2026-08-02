import { useEffect, useState } from 'react'
import { useRpcClientContext, type RpcClientContextValue } from './client-context'

export function useReconnectAttempt(hostId: string | undefined): number {
  return useHostMetric(hostId, (context, id) => context.getReconnectAttempt(id), 0)
}

export function useLastConnectedAt(hostId: string | undefined): number | null {
  return useHostMetric(hostId, (context, id) => context.getLastConnectedAt(id), null)
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
