import { useCallback, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { hostProjectGroupListRead } from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'

const PROJECT_GROUP_REFRESH_MS = 60_000

export function useHostProjectGroupCatalog(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: HostScreenState
}) {
  const { client, connState, hostId, state } = args
  const { clientRef, setProjectGroups } = state
  const inFlightRef = useRef(new WeakSet<RpcClient>())
  const pendingRef = useRef(new WeakSet<RpcClient>())
  const fetchedAtRef = useRef(0)

  const fetchProjectGroups = useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId) {
        return
      }
      if (inFlightRef.current.has(client)) {
        if (options.queueIfInFlight) {
          pendingRef.current.add(client)
        }
        return
      }
      const now = Date.now()
      if (!options.force && now - fetchedAtRef.current < PROJECT_GROUP_REFRESH_MS) {
        return
      }
      inFlightRef.current.add(client)
      const requestClient = client
      const requestHostId = hostId
      try {
        do {
          pendingRef.current.delete(requestClient)
          let reply
          try {
            reply = await hostProjectGroupListRead.request(requestClient)
          } catch {
            return
          }
          if (clientRef.current !== requestClient || hostId !== requestHostId) {
            return
          }
          const groups = hostProjectGroupListRead.interpret(reply)
          if (!groups.accepted) {
            return
          }
          fetchedAtRef.current = Date.now()
          setProjectGroups(groups.value)
        } while (pendingRef.current.has(requestClient))
      } catch {
        // Decorative: the next refresh can retry; the list falls back to Ungrouped.
      } finally {
        inFlightRef.current.delete(requestClient)
      }
    },
    [client, connState, hostId]
  )

  return fetchProjectGroups
}

export type FetchHostProjectGroups = ReturnType<typeof useHostProjectGroupCatalog>
