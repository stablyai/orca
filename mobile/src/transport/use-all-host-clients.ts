import { useEffect, useMemo, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'
import { useRpcClientContext } from './client-context'

// Why: refcounting prevents a double-open when a host-detail screen shares one of these hosts.
export function useAllHostClients(hostIds: string[]) {
  const ctx = useRpcClientContext()
  // Stable key so we don't tear down on every render of the array.
  const key = useMemo(() => [...hostIds].sort().join(','), [hostIds])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (hostIds.length === 0) {
      return
    }
    for (const id of hostIds) {
      ctx.acquire(id)
    }
    const unsubs: (() => void)[] = []
    for (const id of hostIds) {
      unsubs.push(ctx.subscribeHostState(id, () => setTick((n) => n + 1)))
    }
    unsubs.push(ctx.subscribeAllHosts(() => setTick((n) => n + 1)))
    return () => {
      for (const u of unsubs) {
        u()
      }
      for (const id of hostIds) {
        ctx.release(id)
      }
    }
  }, [key])

  return useMemo(() => {
    const out: {
      hostId: string
      client: RpcClient
      state: ConnectionState
      path: MobileConnectionPath
    }[] = []
    for (const id of hostIds) {
      const all = ctx.getAllClients().find((entry) => entry.hostId === id)
      if (all) {
        out.push({
          hostId: id,
          client: all.client,
          state: ctx.getState(id),
          path: ctx.getActivePath(id)
        })
      }
    }
    return out
  }, [key, tick])
}
