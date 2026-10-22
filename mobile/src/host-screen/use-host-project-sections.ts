import { useCallback, useRef } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import {
  projectSectionsRead,
  readServedProjectSections
} from '../worktree/project-sections-operations'
import type { HostScreenState } from './use-host-screen-state'

const PROJECT_SECTIONS_REFRESH_MS = 60_000

type FetchHostProjectSections = (options?: {
  force?: boolean
  queueIfInFlight?: boolean
}) => Promise<void>

type HostProjectSectionsArgs = {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: Pick<HostScreenState, 'clientRef' | 'setServedProjectSections'>
}

/**
 * The desktop sidebar's Project catalog, refreshed with repo metadata but as its own read, so a
 * slow or missing answer never holds the repo labels back.
 */
function useServedProjectSections(args: HostProjectSectionsArgs): FetchHostProjectSections {
  const { client, connState, hostId, state } = args
  const { clientRef, setServedProjectSections } = state
  const inFlight = useRef(new WeakSet<RpcClient>())
  // A read queued while one ran: that one may predate the change this was asked for.
  const queued = useRef(new WeakSet<RpcClient>())
  // Per client, so a reused screen for another host fetches its catalog at once.
  const fetchedAt = useRef(new WeakMap<RpcClient, number>())

  return useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId) {
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
        }
        return true
      }
      // Reads again while a read queued during the last one; each read waits on the one before.
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
    [client, clientRef, connState, hostId, setServedProjectSections]
  )
}

const readNothing: FetchHostProjectSections = async () => {}

/** Switch point: the host's sidebar feed carries the catalog, installed with the rows. */
export const useHostProjectSections: (args: HostProjectSectionsArgs) => FetchHostProjectSections =
  ORCA_SIDEBAR_INPUTS_IS_MAIN ? () => readNothing : useServedProjectSections
