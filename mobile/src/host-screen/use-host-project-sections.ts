import { useCallback, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  projectSectionsRead,
  readServedProjectSections
} from '../worktree/project-sections-operations'
import type { HostScreenState } from './use-host-screen-state'

const PROJECT_SECTIONS_REFRESH_MS = 60_000

/**
 * The desktop sidebar's Project catalog, refreshed with repo metadata but as its own read, so a
 * slow or missing answer never holds the repo labels back.
 */
export function useHostProjectSections(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: Pick<HostScreenState, 'clientRef' | 'setServedProjectSections'>
}): (options?: { force?: boolean }) => Promise<void> {
  const { client, connState, hostId, state } = args
  const { clientRef, setServedProjectSections } = state
  const inFlight = useRef(new WeakSet<RpcClient>())
  // Per client, so a reused screen for another host fetches its catalog at once.
  const fetchedAt = useRef(new WeakMap<RpcClient, number>())

  return useCallback(
    async (options: { force?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId || inFlight.current.has(client)) {
        return
      }
      if (
        !options.force &&
        Date.now() - (fetchedAt.current.get(client) ?? 0) < PROJECT_SECTIONS_REFRESH_MS
      ) {
        return
      }
      inFlight.current.add(client)
      try {
        const reply = await projectSectionsRead.request(client).catch(() => null)
        if (clientRef.current !== client) {
          return
        }
        const sections = readServedProjectSections(reply)
        if (sections.kind === 'answered') {
          fetchedAt.current.set(client, Date.now())
          setServedProjectSections(sections.value)
        }
      } finally {
        inFlight.current.delete(client)
      }
    },
    [client, clientRef, connState, hostId, setServedProjectSections]
  )
}
