import { useEffect, useMemo, useRef, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'
import { useRpcClientContext } from './client-context'
import type { HostClientAcquisition } from './host-client-acquisition-registry'

type UseAllHostClientsOptions = {
  autoConnectHostIds?: readonly string[]
  closeUnusedOnRelease?: boolean
}

export function useAllHostClients(hostIds: string[], options?: UseAllHostClientsOptions) {
  const ctx = useRpcClientContext()
  const autoConnectHostIds = options?.autoConnectHostIds ?? hostIds
  const closeUnusedOnRelease = options?.closeUnusedOnRelease ?? false
  const key = useMemo(
    () =>
      [
        [...hostIds].sort().join(','),
        [...autoConnectHostIds].sort().join(','),
        closeUnusedOnRelease ? 'close' : 'keep'
      ].join('|'),
    [autoConnectHostIds, closeUnusedOnRelease, hostIds]
  )
  const [tick, setTick] = useState(0)
  const acquiredHostIdsRef = useRef<Set<string>>(new Set())
  const acquisitionsRef = useRef<Map<string, HostClientAcquisition>>(new Map())
  const hostUnsubscribesRef = useRef<Map<string, () => void>>(new Map())
  const closeUnusedRef = useRef(closeUnusedOnRelease)

  useEffect(() => {
    closeUnusedRef.current = closeUnusedOnRelease
  }, [closeUnusedOnRelease])

  useEffect(() => {
    const unsubscribeAllHosts = ctx.subscribeAllHosts(() => setTick((value) => value + 1))
    return () => {
      unsubscribeAllHosts()
      const trackedHostIds = [...hostUnsubscribesRef.current.keys()]
      const acquiredHostIds = new Set(acquiredHostIdsRef.current)
      for (const unsubscribe of hostUnsubscribesRef.current.values()) {
        unsubscribe()
      }
      hostUnsubscribesRef.current.clear()
      for (const id of acquiredHostIds) {
        const acquisition = acquisitionsRef.current.get(id)
        if (!acquisition) {
          if (closeUnusedRef.current) {
            ctx.closeIfUnused(id)
          }
          continue
        }
        if (closeUnusedRef.current) {
          ctx.releaseAndCloseIfUnused(id, acquisition)
        } else {
          ctx.release(id, acquisition)
        }
      }
      if (closeUnusedRef.current) {
        for (const id of trackedHostIds) {
          if (!acquiredHostIds.has(id)) {
            ctx.closeIfUnused(id)
          }
        }
      }
      acquiredHostIdsRef.current.clear()
      acquisitionsRef.current.clear()
    }
  }, [ctx])

  useEffect(() => {
    const trackedHostIds = new Set(hostIds)
    const nextAcquiredHostIds = new Set(autoConnectHostIds.filter((id) => trackedHostIds.has(id)))
    const removedTrackedHostIds: string[] = []

    for (const [id, unsubscribe] of hostUnsubscribesRef.current) {
      if (!trackedHostIds.has(id)) {
        unsubscribe()
        hostUnsubscribesRef.current.delete(id)
        removedTrackedHostIds.push(id)
      }
    }
    for (const id of trackedHostIds) {
      if (!hostUnsubscribesRef.current.has(id)) {
        hostUnsubscribesRef.current.set(
          id,
          ctx.subscribeHostState(id, () => setTick((value) => value + 1))
        )
      }
    }

    for (const id of acquiredHostIdsRef.current) {
      if (!nextAcquiredHostIds.has(id)) {
        const acquisition = acquisitionsRef.current.get(id)
        if (!acquisition) {
          if (closeUnusedOnRelease) {
            ctx.closeIfUnused(id)
          }
          continue
        }
        if (closeUnusedOnRelease) {
          ctx.releaseAndCloseIfUnused(id, acquisition)
        } else {
          ctx.release(id, acquisition)
        }
        acquisitionsRef.current.delete(id)
      }
    }
    for (const id of nextAcquiredHostIds) {
      if (!acquiredHostIdsRef.current.has(id)) {
        const acquisition = {}
        acquisitionsRef.current.set(id, acquisition)
        ctx.acquire(id, acquisition)
      }
    }
    if (closeUnusedOnRelease) {
      for (const id of removedTrackedHostIds) {
        ctx.closeIfUnused(id)
      }
      for (const id of trackedHostIds) {
        if (!nextAcquiredHostIds.has(id)) {
          ctx.closeIfUnused(id)
        }
      }
    }
    acquiredHostIdsRef.current = nextAcquiredHostIds
  }, [ctx, key])

  return useMemo(() => {
    const clientsByHostId = new Map(
      ctx.getAllClients().map((entry) => [entry.hostId, entry.client])
    )
    return hostIds.flatMap<{
      hostId: string
      client: RpcClient
      state: ConnectionState
      path: MobileConnectionPath
      pendingPath: MobileConnectionPath | null
      pairingRejected: boolean
    }>((hostId) => {
      const client = clientsByHostId.get(hostId)
      return client
        ? [
            {
              hostId,
              client,
              state: ctx.getState(hostId),
              path: ctx.getActivePath(hostId),
              pendingPath: ctx.getPendingPath(hostId),
              pairingRejected: ctx.isPairingRejected(hostId)
            }
          ]
        : []
    })
  }, [ctx, hostIds, tick])
}
