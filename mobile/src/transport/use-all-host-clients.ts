import { useEffect, useMemo, useRef, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { ConnectionState } from './types'
import { useRpcClientContext } from './client-context'

type UseAllHostClientsOptions = {
  autoConnectHostIds?: readonly string[]
  closeUnusedOnRelease?: boolean
  observeConnectionState?: boolean
}

export function useAllHostClients(hostIds: string[], options?: UseAllHostClientsOptions) {
  const ctx = useRpcClientContext()
  const autoConnectHostIds = options?.autoConnectHostIds ?? hostIds
  const closeUnusedOnRelease = options?.closeUnusedOnRelease ?? false
  const observeConnectionState = options?.observeConnectionState ?? true
  const key = useMemo(
    () =>
      [
        [...hostIds].sort().join(','),
        [...autoConnectHostIds].sort().join(','),
        closeUnusedOnRelease ? 'close' : 'keep',
        observeConnectionState ? 'state' : 'client'
      ].join('|'),
    [autoConnectHostIds, closeUnusedOnRelease, hostIds, observeConnectionState]
  )
  const [tick, setTick] = useState(0)
  const acquiredHostIdsRef = useRef<Set<string>>(new Set())
  const hostUnsubscribesRef = useRef<Map<string, () => void>>(new Map())
  const observedClientsRef = useRef<Map<string, RpcClient | null>>(new Map())
  const closeUnusedRef = useRef(closeUnusedOnRelease)
  // Why: host-state subscriptions outlive an option change, so the callback must read the live value.
  const observeConnectionStateRef = useRef(observeConnectionState)

  useEffect(() => {
    closeUnusedRef.current = closeUnusedOnRelease
  }, [closeUnusedOnRelease])

  useEffect(() => {
    observeConnectionStateRef.current = observeConnectionState
  }, [observeConnectionState])

  useEffect(() => {
    return () => {
      const trackedHostIds = [...hostUnsubscribesRef.current.keys()]
      const acquiredHostIds = new Set(acquiredHostIdsRef.current)
      for (const unsubscribe of hostUnsubscribesRef.current.values()) {
        unsubscribe()
      }
      hostUnsubscribesRef.current.clear()
      for (const id of acquiredHostIds) {
        if (closeUnusedRef.current) {
          ctx.releaseAndCloseIfUnused(id)
        } else {
          ctx.release(id)
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
      observedClientsRef.current.clear()
    }
  }, [ctx])

  useEffect(() => {
    const trackedHostIds = new Set(hostIds)
    const nextAcquiredHostIds = new Set(autoConnectHostIds.filter((id) => trackedHostIds.has(id)))
    const removedTrackedHostIds: string[] = []
    let foundClientOpenedBeforeSubscription = false

    for (const [id, unsubscribe] of hostUnsubscribesRef.current) {
      if (!trackedHostIds.has(id)) {
        unsubscribe()
        hostUnsubscribesRef.current.delete(id)
        observedClientsRef.current.delete(id)
        removedTrackedHostIds.push(id)
      }
    }
    for (const id of trackedHostIds) {
      if (!hostUnsubscribesRef.current.has(id)) {
        const existingClient = ctx.getClient(id)
        observedClientsRef.current.set(id, existingClient)
        foundClientOpenedBeforeSubscription ||= existingClient !== null
        hostUnsubscribesRef.current.set(
          id,
          ctx.subscribeHostState(id, () => {
            const nextClient = ctx.getClient(id)
            if (
              observeConnectionStateRef.current ||
              observedClientsRef.current.get(id) !== nextClient
            ) {
              observedClientsRef.current.set(id, nextClient)
              setTick((value) => value + 1)
            }
          })
        )
      }
    }

    if (foundClientOpenedBeforeSubscription) {
      setTick((value) => value + 1)
    }

    for (const id of acquiredHostIdsRef.current) {
      if (!nextAcquiredHostIds.has(id)) {
        if (closeUnusedOnRelease) {
          ctx.releaseAndCloseIfUnused(id)
        } else {
          ctx.release(id)
        }
      }
    }
    for (const id of nextAcquiredHostIds) {
      if (!acquiredHostIdsRef.current.has(id)) {
        ctx.acquire(id)
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
    return hostIds.flatMap<{
      hostId: string
      client: RpcClient
      state: ConnectionState
      path: MobileConnectionPath
    }>((hostId) => {
      const client = ctx.getClient(hostId)
      return client
        ? [{ hostId, client, state: ctx.getState(hostId), path: ctx.getActivePath(hostId) }]
        : []
    })
  }, [ctx, hostIds, tick])
}
