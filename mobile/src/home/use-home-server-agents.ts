import { useCallback, useMemo } from 'react'
import { useQueries, type QueryObserverResult } from '@tanstack/react-query'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../host-screen/catalog/host-list-queries'
import { hostObserverOptions } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { homeServerAgentsQuery } from '../worktree/catalog/home-host-worktree-fetch'
import {
  withRelayedServerAgents,
  type HomeServerAgentsRead,
  type HostWorktreeInfo
} from '../worktree/catalog/home-worktree-info'

/**
 * Each desktop's worktree info with the agents of the servers it relays added, each server once.
 * A server's agents are re-read only when its desktop says they changed, never on a timer.
 */
export function useHomeServerAgents(
  homeHosts: readonly { hostId: string; client: RpcClient | null }[],
  isLive: (hostId: string, readAt: number) => boolean,
  subscribed: boolean,
  hostsInOrder: readonly { id: string }[],
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
): Readonly<Record<string, HostWorktreeInfo>> {
  const queries = useMemo(
    () =>
      homeHosts.map((host) =>
        hostObserverOptions(
          homeServerAgentsQuery,
          host.client,
          host.hostId,
          HOST_LIST_TARGET,
          NO_HOST_LIST_INPUT
        )
      ),
    [homeHosts]
  )
  // Like a desktop's own agents, a relayed server's show only from a read on this connection.
  const combine = useCallback(
    (
      results: QueryObserverResult<HomeServerAgentsRead>[]
    ): Record<string, HomeServerAgentsRead> => {
      const byHost: Record<string, HomeServerAgentsRead> = {}
      homeHosts.forEach(({ hostId }, at) => {
        const result = results[at]
        if (result?.data && isLive(hostId, result.dataUpdatedAt)) {
          byHost[hostId] = result.data
        }
      })
      return byHost
    },
    [homeHosts, isLive]
  )
  const serverAgents = useQueries({ queries, combine, subscribed })
  return useMemo(
    () =>
      withRelayedServerAgents(
        hostsInOrder.map((host) => host.id),
        worktreeInfo,
        serverAgents
      ),
    [hostsInOrder, worktreeInfo, serverAgents]
  )
}
