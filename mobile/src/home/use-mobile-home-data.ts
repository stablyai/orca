import { useRouter, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  notifyManager,
  replaceEqualDeep,
  useQueries,
  useQueryClient,
  type QueryObserverResult
} from '@tanstack/react-query'
import { warmUpWebShell } from '../../modules/orca-mobile-web-shell/src'
import {
  countAgentsNeedingYouByHost,
  selectActiveAgents,
  selectAgentsNeedingYou,
  type AgentListInput
} from '../agents/agent-list-rows'
import { useAgentActivityWrites } from '../agents/use-agent-activity-writes'
import { accountsSnapshotOptions } from '../accounts/accounts-snapshot-stream'
import type { AccountsSnapshot } from '../accounts/accounts-snapshot'
import {
  HOST_LIST_TARGET,
  homeWorktreeCountsKey,
  NO_HOST_LIST_INPUT
} from '../host-screen/catalog/host-list-queries'
import { useNow } from '../hooks/use-now'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../onboarding/mobile-onboarding-plan'
import {
  selectConnectableHostProfiles,
  sortHostsByLastConnected
} from '../host-catalog/host-catalog-selection'
import { loadHostCatalog } from '../host-catalog/host-store'
import type { HostCatalogEntry } from '../host-catalog/host-profile'
import { hostObserverOptions, type HostQuery } from '../query/host-query'
import { isHostNotConnectedError } from '../query/host-query-errors'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  homeWorktreeCountsQuery,
  type HomeWorktreeCounts
} from '../worktree/catalog/home-host-worktree-fetch'
import { homeWorktreeInfo, type HostWorktreeInfo } from '../worktree/catalog/home-worktree-info'
import { homeStatsQuery } from '../stats/home-stats-summary-read'
import { totalHomeStats, type HomeStatsRow } from '../stats/home-stats-total'
import { projectHomeHostConnections } from './home-host-connection-projection'
import { restoreHomeQueries } from './home-query-restore'
import { useMobileHomeHostConnections } from './use-mobile-home-host-connections'

export type MobileHomeData = ReturnType<typeof useMobileHomeData>

// A paired desktop with its client, or none while Home holds no connection to it (disconnected, never opened).
type HomeHost = { hostId: string; client: RpcClient | null }

// Home reads one of each per paired desktop. Reads stay on while a desktop connects: the connected edge
// re-reads them the moment it lands, with no render in between, and a read tried before it is refused at once.
const homeQueryOptions = <TData>(
  query: HostQuery<typeof NO_HOST_LIST_INPUT, TData>,
  host: HomeHost
) => hostObserverOptions(query, host.client, host.hostId, HOST_LIST_TARGET, NO_HOST_LIST_INPUT)

const readOf = (result: QueryObserverResult<HomeWorktreeCounts>) => ({
  data: result.data,
  dataUpdatedAt: result.dataUpdatedAt,
  // A read refused because the desktop isn't connected yet says nothing about its list.
  failed: result.isError && !isHostNotConnectedError(result.error)
})

export function useMobileHomeData() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [hostCatalog, setHostCatalog] = useState<HostCatalogEntry[]>([])
  // Until the catalog read lands, an empty list says nothing; a paired user must not see first-run.
  const [hostCatalogLoaded, setHostCatalogLoaded] = useState(false)
  const onboardingCheckedRef = useRef(false)
  // Drives the agent clock and Home's reads; Home stays mounted under other screens.
  const [homeFocused, setHomeFocused] = useState(false)
  const hosts = useMemo(() => selectConnectableHostProfiles(hostCatalog), [hostCatalog])
  const connections = useMobileHomeHostConnections(hosts, hostCatalog)
  const { allClients, hostLastConnected, hostStates } = connections
  const allClientsRef = useRef(allClients)
  // Every paired desktop keeps its last counts and totals on Home, connected or not.
  const homeHosts = useMemo((): HomeHost[] => {
    const clients = new Map(allClients.map((entry) => [entry.hostId, entry.client]))
    return hosts.map((host) => ({ hostId: host.id, client: clients.get(host.id) ?? null }))
  }, [hosts, allClients])
  // A read from before the desktop's latest connect, or from an earlier launch, can't vouch for agents or usage.
  const isLive = useCallback(
    (hostId: string, readAt: number): boolean => {
      const connectedAt = hostLastConnected[hostId]
      return connectedAt != null && readAt >= connectedAt
    },
    [hostLastConnected]
  )

  // Once the first desktop list is up: counts show only after a desktop connects, so the rows never wait
  // for the store, and its keychain read doesn't compete with the list's. Before the queries below, whose
  // observers then join this batched read instead of each reading its own row.
  const storeRestoredRef = useRef(false)
  useEffect(() => {
    if (storeRestoredRef.current || hostCatalog.length === 0) {
      return
    }
    storeRestoredRef.current = true
    void restoreHomeQueries(
      queryClient,
      hostCatalog.map((host) => host.id)
    )
  }, [hostCatalog, queryClient])

  const countsQueries = useMemo(
    () => homeHosts.map((host) => homeQueryOptions(homeWorktreeCountsQuery, host)),
    [homeHosts]
  )
  const combineCounts = useCallback(
    (results: QueryObserverResult<HomeWorktreeCounts>[]): Record<string, HostWorktreeInfo> => {
      const byHost: Record<string, HostWorktreeInfo> = {}
      homeHosts.forEach(({ hostId }, at) => {
        const result = results[at]
        const info = result && homeWorktreeInfo(hostId, readOf(result), isLive)
        if (info) {
          byHost[hostId] = info
        }
      })
      return byHost
    },
    [homeHosts, isLive]
  )
  // A hidden Home reads nothing; coming back reads what went stale meanwhile.
  const worktreeInfo = useQueries({
    queries: countsQueries,
    combine: combineCounts,
    subscribed: homeFocused
  })
  const statsQueries = useMemo(
    () => homeHosts.map((host) => homeQueryOptions(homeStatsQuery, host)),
    [homeHosts]
  )
  const combineStats = useCallback(
    (results: QueryObserverResult<HomeStatsRow>[]): Record<string, HomeStatsRow> =>
      Object.fromEntries(homeHosts.map(({ hostId }, at) => [hostId, results[at]?.data])),
    [homeHosts]
  )
  const statsByHost = useQueries({
    queries: statsQueries,
    combine: combineStats,
    subscribed: homeFocused
  })
  const accountsQueries = useMemo(
    () => homeHosts.map(({ hostId }) => accountsSnapshotOptions(hostId)),
    [homeHosts]
  )
  // Usage is live: only a snapshot from this connection shows, never a stored or disconnected one.
  const combineAccounts = useCallback(
    (results: QueryObserverResult<AccountsSnapshot | null>[]): Record<string, AccountsSnapshot> => {
      const byHost: Record<string, AccountsSnapshot> = {}
      homeHosts.forEach(({ hostId }, at) => {
        const result = results[at]
        if (
          result?.data &&
          hostStates[hostId] === 'connected' &&
          isLive(hostId, result.dataUpdatedAt)
        ) {
          byHost[hostId] = result.data
        }
      })
      return byHost
    },
    [homeHosts, hostStates, isLive]
  )
  const accountsByHost = useQueries({
    queries: accountsQueries,
    combine: combineAccounts,
    subscribed: homeFocused
  })

  const hasPairedHost = hosts.length > 0
  useEffect(() => {
    if (hasPairedHost) {
      warmUpWebShell()
    }
  }, [hasPairedHost])

  useEffect(() => {
    allClientsRef.current = allClients
  }, [allClients])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      setHomeFocused(true)
      void loadHostCatalog()
        // A failed read proves nothing about the desktops; keep the ones already shown.
        .catch((): HostCatalogEntry[] | null => null)
        .then(async (catalog) => {
          if (stale) {
            return
          }
          setHostCatalogLoaded(true)
          if (!catalog) {
            return
          }
          // An unchanged list keeps its identity, so focusing Home again redraws nothing.
          setHostCatalog((previous) => replaceEqualDeep(previous, catalog))
          if (catalog.length === 0 || onboardingCheckedRef.current) {
            return
          }
          onboardingCheckedRef.current = true
          const steps = await loadMobileOnboardingSteps()
          if (!stale && steps.length > 0) {
            router.replace(mobileOnboardingDestination(steps))
          }
        })
      return () => {
        stale = true
        setHomeFocused(false)
      }
    }, [router])
  )

  const sortedHosts = useMemo(() => sortHostsByLastConnected(hosts), [hosts])
  const sortedHostCatalog = useMemo(() => sortHostsByLastConnected(hostCatalog), [hostCatalog])
  // One clock for every agent count, so Feed, the Agents badge and each desktop agree.
  const now = useNow(30_000, homeFocused)
  // A fresh read, not one already out: that one may predate the write it must carry. The cached rows stay
  // its delta base, so the desktop answers with only what changed.
  const refetchHostAgents = useCallback(
    async (hostId: string): Promise<void> => {
      const entry = allClientsRef.current.find((candidate) => candidate.hostId === hostId)
      if (entry?.client.getState() !== 'connected') {
        return
      }
      await queryClient
        .refetchQueries(
          { queryKey: homeWorktreeCountsKey(hostId), exact: true },
          { cancelRefetch: true, throwOnError: false }
        )
        .catch(() => undefined)
      // Resolves once observers hold the answer, so the write's guess isn't dropped a frame early.
      await new Promise<void>((resolve) => notifyManager.schedule(resolve))
    },
    [queryClient]
  )
  const agentActivity = useAgentActivityWrites(allClients, refetchHostAgents)
  const { pendingActivity } = agentActivity
  const agentList = useMemo<AgentListInput>(
    () => ({
      hosts: sortedHosts,
      hostStates,
      worktreeInfo,
      now,
      pendingActivity
    }),
    [sortedHosts, hostStates, worktreeInfo, now, pendingActivity]
  )
  const agentsNeedingYou = useMemo(() => selectAgentsNeedingYou(agentList), [agentList])
  const activeAgents = useMemo(() => selectActiveAgents(agentList), [agentList])
  const needsYouByHost = useMemo(
    () => countAgentsNeedingYouByHost(agentsNeedingYou),
    [agentsNeedingYou]
  )
  const connectedHosts = useMemo(
    () => sortedHosts.filter((host) => hostStates[host.id] === 'connected'),
    [sortedHosts, hostStates]
  )
  // Before a desktop's first connect settles, "not connected" is not yet true.
  const hostsConnecting = hosts.some((host) => {
    const state = hostStates[host.id]
    return state === undefined || state === 'connecting' || state === 'handshaking'
  })
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const stats = useMemo(() => totalHomeStats(statsByHost, hostIds), [statsByHost, hostIds])
  const hostConnections = useMemo(() => projectHomeHostConnections(allClients), [allClients])

  return {
    ...connections,
    accountsByHost,
    applyAgentActivity: agentActivity.apply,
    activeAgents,
    agentList,
    agentsNeedingYou,
    connectedHosts,
    hostCatalog,
    hostCatalogLoaded,
    hostConnections,
    hostsConnecting,
    needsYouByHost,
    router,
    setHostCatalog,
    sortedHostCatalog,
    sortedHosts,
    stats,
    worktreeInfo
  }
}
