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

// Refresh Project catalog independently so slow/missing replies do not hold back repo labels; skip while the sidebar feed supplies it with the rows.
export function useHostProjectSections(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: Pick<HostScreenState, 'clientRef' | 'setServedProjectSections' | 'setHostProjectGroups'>
  feedCarriesCatalog?: () => boolean
}): (options?: { force?: boolean; queueIfInFlight?: boolean }) => Promise<void> {
  const { client, connState, hostId, state, feedCarriesCatalog } = args
  const { clientRef, setServedProjectSections, setHostProjectGroups } = state
  const inFlight = useRef(new WeakSet<RpcClient>())
  // A read queued while one ran: that one may predate the change this was asked for.
  const queued = useRef(new WeakSet<RpcClient>())
  // Per client, so a reused screen for another host fetches its catalog at once.
  const fetchedAt = useRef(new WeakMap<RpcClient, number>())

  return useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId || feedCarriesCatalog?.()) {
        return
      }
      if (inFlight.current.has(client)) {
        if (options.queueIfInFlight) {
          queued.current.add(client)
        }
        return
      }
      if (
        !options.force &&
        Date.now() - (fetchedAt.current.get(client) ?? 0) < PROJECT_SECTIONS_REFRESH_MS
      ) {
        return
      }
      const readOnce = async (): Promise<boolean> => {
        const reply = await projectSectionsRead.request(client).catch(() => null)
        if (clientRef.current !== client) {
          return false
        }
        const sections = readServedProjectSections(reply)
        if (sections.kind === 'answered') {
          fetchedAt.current.set(client, Date.now())
          setServedProjectSections(sections.value)
          // Switch point: with no window catalog's groups, a feed-built list reads the host's own.
          if (ORCA_SIDEBAR_INPUTS_IS_MAIN && !sections.value?.projectGroups) {
            const groupReply = await hostProjectGroupsRead.request(client).catch(() => null)
            const groups =
              groupReply && readHostMethodReply(groupReply, hostProjectGroupsRead.interpret)
            if (groups?.kind === 'answered' && clientRef.current === client) {
              setHostProjectGroups(groups.value)
            }
          }
        }
        return true
      }
      const readUntilCurrent = async (): Promise<void> => {
        queued.current.delete(client)
        if ((await readOnce()) && queued.current.has(client)) {
          await readUntilCurrent()
        }
      }
      inFlight.current.add(client)
      try {
        await readUntilCurrent()
      } finally {
        inFlight.current.delete(client)
      }
    },
    [
      client,
      clientRef,
      connState,
      feedCarriesCatalog,
      hostId,
      setServedProjectSections,
      setHostProjectGroups
    ]
  )
}
