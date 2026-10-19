import { useCallback, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import {
  hostProjectGroupsRead,
  projectSectionsRead,
  readServedProjectSections
} from '../worktree/project-sections-operations'
import { readHostMethodReply } from './host-sidebar-feed-operations'
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
  state: Pick<HostScreenState, 'clientRef' | 'setServedProjectSections' | 'setHostProjectGroups'>
}): (options?: { force?: boolean }) => Promise<void> {
  const { client, connState, hostId, state } = args
  const { clientRef, setServedProjectSections, setHostProjectGroups } = state
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
          // Switch point: with no window catalog's groups, a feed-built list reads the host's own.
          if (ORCA_SIDEBAR_INPUTS_IS_MAIN && !sections.value?.projectGroups) {
            const reply = await hostProjectGroupsRead.request(client).catch(() => null)
            const groups = reply && readHostMethodReply(reply, hostProjectGroupsRead.interpret)
            if (groups?.kind === 'answered' && clientRef.current === client) {
              setHostProjectGroups(groups.value)
            }
          }
        }
      } finally {
        inFlight.current.delete(client)
      }
    },
    [client, clientRef, connState, hostId, setServedProjectSections, setHostProjectGroups]
  )
}
