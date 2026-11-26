import { useCallback, useMemo } from 'react'
import { useQueries, type QueryObserverResult } from '@tanstack/react-query'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../host-screen/catalog/host-list-queries'
import { hostObserverOptions } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { HostWorktreeInfo } from '../worktree/catalog/home-worktree-info'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import {
  homeRelayedServerRowsQuery,
  homeRelayedServersQuery,
  relayedServerRowsPollMs
} from './home-relayed-server-queries'
import {
  pickRelayedServers,
  withRelayedServerAgents,
  type HomeRelayedServers,
  type HomeRelayedServersRead
} from './home-relayed-servers'

/**
 * Each desktop's worktree info with the agents of the servers it relays added, each server once.
 * A server's agents are re-read only when its desktop says that server's rows changed, never on a timer.
 */
export function useHomeServerAgents(
  homeHosts: readonly { hostId: string; client: RpcClient | null }[],
  isLive: (hostId: string, readAt: number) => boolean,
  subscribed: boolean,
  hostsInOrder: readonly { id: string }[],
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
): Readonly<Record<string, HostWorktreeInfo>> {
  const serverQueries = useMemo(
    () =>
      homeHosts.map((host) =>
        hostObserverOptions(
          homeRelayedServersQuery,
          host.client,
          host.hostId,
          HOST_LIST_TARGET,
          NO_HOST_LIST_INPUT
        )
      ),
    [homeHosts]
  )
  const combineServers = useCallback(
    (results: QueryObserverResult<HomeRelayedServers>[]) => {
      const byHost: Record<string, HomeRelayedServersRead> = {}
      homeHosts.forEach(({ hostId }, at) => {
        const result = results[at]
        byHost[hostId] = {
          data: result?.data,
          live: result?.data !== undefined && isLive(hostId, result.dataUpdatedAt)
        }
      })
      return byHost
    },
    [homeHosts, isLive]
  )
  const reads = useQueries({ queries: serverQueries, combine: combineServers, subscribed })
  const picks = useMemo(
    () =>
      pickRelayedServers(
        hostsInOrder.map((host) => host.id),
        reads
      ),
    [hostsInOrder, reads]
  )
  const rowQueries = useMemo(() => {
    const clients = new Map(homeHosts.map((host) => [host.hostId, host.client]))
    return picks.map((pick) => ({
      ...hostObserverOptions(
        homeRelayedServerRowsQuery,
        clients.get(pick.desktopHostId) ?? null,
        pick.desktopHostId,
        { exec: pick.server.hostId },
        { deltas: pick.deltas, rowChanges: pick.server.rowChanges === true }
      ),
      refetchInterval: relayedServerRowsPollMs(pick.server)
    }))
  }, [homeHosts, picks])
  // Like a desktop's own agents, a relayed server's show only from a read on this connection.
  const combineRows = useCallback(
    (results: QueryObserverResult<readonly Worktree[]>[]) =>
      picks.map((pick, at) => {
        const result = results[at]
        return result?.data && isLive(pick.desktopHostId, result.dataUpdatedAt)
          ? result.data
          : undefined
      }),
    [picks, isLive]
  )
  const rows = useQueries({ queries: rowQueries, combine: combineRows, subscribed })
  return useMemo(
    () => withRelayedServerAgents(worktreeInfo, picks, rows),
    [worktreeInfo, picks, rows]
  )
}
