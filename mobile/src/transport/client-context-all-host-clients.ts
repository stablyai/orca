import { useEffect, useMemo, useState } from 'react'
import { useRpcClientContext } from './rpc-client-react-context'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'

export function useAllHostClients(hostIds: string[]) {
  const context = useRpcClientContext()
  const key = useMemo(() => [...hostIds].sort().join(','), [hostIds])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (hostIds.length === 0) {
      return
    }
    for (const id of hostIds) {
      context.acquire(id)
    }
    const unsubscribes = hostIds.map((id) =>
      context.subscribeHostState(id, () => setTick((value) => value + 1))
    )
    unsubscribes.push(context.subscribeAllHosts(() => setTick((value) => value + 1)))
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
      for (const id of hostIds) {
        context.release(id)
      }
    }
  }, [key])

  return useMemo(() => {
    const clients: {
      hostId: string
      client: RpcClient
      state: ConnectionState
      path: MobileConnectionPath
    }[] = []
    for (const id of hostIds) {
      const found = context.getAllClients().find((entry) => entry.hostId === id)
      if (found) {
        clients.push({
          hostId: id,
          client: found.client,
          state: context.getState(id),
          path: context.getActivePath(id)
        })
      }
    }
    return clients
  }, [key, tick])
}
