import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useQueries, type QueryObserverResult } from '@tanstack/react-query'
import { HOST_LIST_TARGET, NO_HOST_LIST_INPUT } from '../../host-screen/catalog/host-list-queries'
import { hostObserverOptions } from '../../query/host-query'
import { hostConnectionEpoch } from '../../query/host-status-query'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { HostWorktreeInfo } from '../../worktree/catalog/home-worktree-info'
import { homeBotRows } from './home-bot-rows'
import { homeBotsQuery, type HomeComputerBots } from './home-bots-query'
import type { KeptComputerBots } from '../../bots/kept-computer-bots'
import {
  foldKeptHomeComputer,
  hydrateKeptHomeComputers,
  keptHomeComputers,
  subscribeKeptHomeComputers
} from './kept-home-computers'

const combine = (results: QueryObserverResult<HomeComputerBots>[]) =>
  results.map((result) => result.data)

/** Home's bots: one read per paired computer, each computer's last answers kept, and the rows. */
export function useHomeBots(args: {
  homeHosts: readonly { hostId: string; client: RpcClient | null }[]
  /** Paired computers in Home's order. */
  hosts: readonly { id: string; name: string }[]
  hostStates: Readonly<Record<string, ConnectionState>>
  unreachableHosts: ReadonlySet<string>
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
  now: number
  subscribed: boolean
}) {
  const { homeHosts, hosts, hostStates, unreachableHosts, worktreeInfo, now, subscribed } = args
  const queries = useMemo(
    () =>
      homeHosts.map((host) =>
        hostObserverOptions(
          homeBotsQuery,
          host.client,
          host.hostId,
          HOST_LIST_TARGET,
          NO_HOST_LIST_INPUT
        )
      ),
    [homeHosts]
  )
  const results = useQueries({ queries, combine, subscribed })
  // A read is live only on the connection it came over; one from before a reconnect is kept, not live.
  const { reads, fresh } = useMemo(() => {
    const byHost: Record<string, HomeComputerBots | undefined> = {}
    const current = new Set<string>()
    homeHosts.forEach(({ hostId, client }, at) => {
      const read = results[at]
      byHost[hostId] = read
      if (
        read &&
        client &&
        hostStates[hostId] === 'connected' &&
        read.epoch === hostConnectionEpoch(client)
      ) {
        current.add(hostId)
      }
    })
    return { reads: byHost, fresh: current }
  }, [homeHosts, results, hostStates])
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const records = useSyncExternalStore(subscribeKeptHomeComputers, keptHomeComputers)
  // Each computer's device copy is read once per generation; a dropped record is read again.
  useEffect(() => hydrateKeptHomeComputers(hostIds), [hostIds, records])
  const { kept, hydrated } = useMemo(() => {
    const byHost: Record<string, KeptComputerBots> = {}
    const done = new Set<string>()
    for (const id of hostIds) {
      const record = records.get(id)
      if (record && record.hydration !== 'reading') {
        done.add(id)
        if (record.kept) {
          byHost[id] = record.kept
        }
      }
    }
    return { kept: byHost, hydrated: done }
  }, [hostIds, records])
  const bots = useMemo(
    () =>
      homeBotRows({
        hosts,
        hostStates,
        unreachableHosts,
        botsByHost: reads,
        freshHosts: fresh,
        kept,
        hydrated,
        worktreeInfo,
        now
      }),
    [hosts, hostStates, unreachableHosts, reads, fresh, kept, hydrated, worktreeInfo, now]
  )
  // Folds each live read into its computer's record; the record skips a read it already holds. Only a
  // shown Home folds: a hidden one's reads are frozen, and two Homes folding different reads never settle.
  useEffect(() => {
    if (!subscribed) {
      return
    }
    for (const hostId of fresh) {
      const read = reads[hostId]
      if (read && hydrated.has(hostId)) {
        foldKeptHomeComputer(hostId, read, bots.activityByHost.get(hostId) ?? {})
      }
    }
  }, [subscribed, fresh, reads, hydrated, bots.activityByHost])
  return { bots, botsByHost: reads }
}
