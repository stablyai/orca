import { useEffect, useState } from 'react'
import { useRpcClientContext } from './rpc-client-react-context'
import type { RpcClientContextValue } from './rpc-client-context-contract'

export function useReconnectAttempt(hostId: string | undefined): number {
  return useHostMetric(hostId, (context, id) => context.getReconnectAttempt(id), 0)
}

export function useLastConnectedAt(hostId: string | undefined): number | null {
  return useHostMetric(hostId, (context, id) => context.getLastConnectedAt(id), null)
}

// Why: latch/recovery notifications arrive through subscribeHostState — the
// context re-broadcasts responsiveness transitions, so no hook ever polls.
export function useRpcUnresponsiveSince(hostId: string | undefined): number | null {
  return useHostMetric(hostId, (context, id) => context.getRpcUnresponsiveSince(id), null)
}

export function useConnectionHealthInputs(hostId: string | undefined) {
  return {
    reconnectAttempts: useReconnectAttempt(hostId),
    lastConnectedAt: useLastConnectedAt(hostId),
    rpcUnresponsiveSince: useRpcUnresponsiveSince(hostId)
  }
}

export function useRpcUnresponsiveByHost(hostIds: string[]): Record<string, number | null> {
  const context = useRpcClientContext()
  const [values, setValues] = useState<Record<string, number | null>>({})
  const hostKey = hostIds.join('\u0000')
  useEffect(() => {
    const read = () => {
      setValues((previous) => {
        const next = Object.fromEntries(
          hostIds.map((id) => [id, context.getRpcUnresponsiveSince(id)])
        )
        // Why: state churn fans out here on every reconnect tick — keep the
        // previous identity when no host's verdict actually changed.
        return recordsEqual(previous, next) ? previous : next
      })
    }
    read()
    const unsubscribes = hostIds.map((id) => context.subscribeHostState(id, read))
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [context, hostIds, hostKey])
  return values
}

function recordsEqual(
  previous: Record<string, number | null>,
  next: Record<string, number | null>
): boolean {
  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  return (
    previousKeys.length === nextKeys.length &&
    nextKeys.every((key) => key in previous && previous[key] === next[key])
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
