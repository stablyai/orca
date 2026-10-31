import { useCallback, useEffect } from 'react'
import { useOwnerProjectSections } from '../worktree/use-owner-project-sections'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import { hostProjectGroupsRead } from '../worktree/project-sections-operations'
import { readHostMethodReply } from './host-sidebar-feed-operations'
import type { HostScreenState } from './use-host-screen-state'

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
  const { answer, refresh } = useOwnerProjectSections(
    client,
    Boolean(client && hostId && !feedCarriesCatalog?.())
  )
  useEffect(() => {
    if (answer.kind === 'answered' && clientRef.current === client) {
      setServedProjectSections(answer.value)
    }
  }, [answer, client, clientRef, setServedProjectSections])
  return useCallback(
    async (options: { force?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId || feedCarriesCatalog?.()) {
        return
      }
      await refresh?.(options.force || options.queueIfInFlight || false)
      if (ORCA_SIDEBAR_INPUTS_IS_MAIN && !('value' in answer && answer.value?.projectGroups)) {
        const groupReply = await hostProjectGroupsRead.request(client).catch(() => null)
        const groups =
          groupReply && readHostMethodReply(groupReply, hostProjectGroupsRead.interpret)
        if (groups?.kind === 'answered' && clientRef.current === client) {
          setHostProjectGroups(groups.value)
        }
      }
    },
    [
      client,
      connState,
      hostId,
      feedCarriesCatalog,
      refresh,
      answer,
      clientRef,
      setHostProjectGroups
    ]
  )
}
