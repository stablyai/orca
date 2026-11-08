import { useRouter, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { warmUpWebShell } from '../../modules/orca-mobile-web-shell/src'
import {
  countAgentsNeedingYouByHost,
  selectAgentsNeedingYou,
  type AgentListInput
} from '../agents/agent-list-rows'
import { useAgentActivityWrites } from '../agents/use-agent-activity-writes'
import { loadHomeSnapshot, saveHomeSnapshot } from '../cache/home-snapshot-cache'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { setCachedWorktrees } from '../cache/worktree-cache'
import { useNow } from '../hooks/use-now'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../onboarding/mobile-onboarding-plan'
import {
  selectConnectableHostProfiles,
  sortHostsByLastConnected
} from '../transport/hosts/host-catalog-selection'
import { loadHostCatalog } from '../transport/hosts/host-store'
import type { HostCatalogEntry } from '../transport/hosts/host-profile'
import { fetchHomeHostWorktreeInfo } from '../worktree/home-host-worktree-fetch'
import { withoutHomeAgentStates, type HostWorktreeInfo } from '../worktree/home-worktree-info'
import { fetchHomeHostStats } from '../stats/home-stats-summary-read'
import { totalHomeStats, type HomeStatsRow } from '../stats/home-stats-total'
import { projectHomeHostConnections } from './home-host-connection-projection'
import { useMobileHomeHostConnections } from './use-mobile-home-host-connections'

export type MobileHomeData = ReturnType<typeof useMobileHomeData>

export function useMobileHomeData() {
  const router = useRouter()
  const [hostCatalog, setHostCatalog] = useState<HostCatalogEntry[]>([])
  // Until the catalog read lands, an empty list says nothing; a paired user must not see first-run.
  const [hostCatalogLoaded, setHostCatalogLoaded] = useState(false)
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [statsByHost, setStatsByHost] = useState<Record<string, HomeStatsRow>>({})
  const [accountsByHost, setAccountsByHost] = useState<Record<string, AccountsSnapshot>>({})
  const hostSetters = useMemo(
    () => ({ setWorktreeInfo, setStats: setStatsByHost, setAccounts: setAccountsByHost }),
    []
  )
  const onboardingCheckedRef = useRef(false)
  const hydratedRef = useRef(false)
  const focusedRef = useRef(false)
  const isHomeFocused = useCallback(() => focusedRef.current, [])
  // Drives the agent clock; Home stays mounted under other screens.
  const [homeFocused, setHomeFocused] = useState(false)
  const hosts = useMemo(() => selectConnectableHostProfiles(hostCatalog), [hostCatalog])
  const connections = useMobileHomeHostConnections(hosts, hostCatalog, hostSetters, isHomeFocused)
  const allClientsRef = useRef(connections.allClients)

  useEffect(() => {
    if (hydratedRef.current) {
      return
    }
    hydratedRef.current = true
    let cancelled = false
    void loadHomeSnapshot().then((snapshot) => {
      if (cancelled || !snapshot) {
        return
      }
      setWorktreeInfo((previous) =>
        Object.keys(previous).length > 0
          ? previous
          : Object.fromEntries(
              Object.entries(snapshot.worktreeInfo).map(([hostId, info]) => [
                hostId,
                withoutHomeAgentStates(info)
              ])
            )
      )
      for (const [hostId, info] of Object.entries(snapshot.worktreeInfo)) {
        if (info.lastActiveWorktree) {
          setCachedWorktrees(hostId, [info.lastActiveWorktree])
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (Object.keys(worktreeInfo).length > 0) {
      const saved = Object.fromEntries(
        Object.entries(worktreeInfo).map(([hostId, info]) => [hostId, withoutHomeAgentStates(info)])
      )
      saveHomeSnapshot({ worktreeInfo: saved, savedAt: Date.now() })
    }
  }, [worktreeInfo])

  const hasPairedHost = hosts.length > 0
  useEffect(() => {
    if (hasPairedHost) {
      warmUpWebShell()
    }
  }, [hasPairedHost])

  useEffect(() => {
    allClientsRef.current = connections.allClients
  }, [connections.allClients])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      focusedRef.current = true
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
          setHostCatalog(catalog)
          if (catalog.length === 0 || onboardingCheckedRef.current) {
            return
          }
          onboardingCheckedRef.current = true
          const steps = await loadMobileOnboardingSteps()
          if (!stale && steps.length > 0) {
            router.replace(mobileOnboardingDestination(steps))
          }
        })
      for (const entry of allClientsRef.current) {
        if (entry.client.getState() === 'connected') {
          void fetchHomeHostWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => stale)
          fetchHomeHostStats(entry.client, entry.hostId, setStatsByHost, () => stale)
        }
      }
      return () => {
        stale = true
        focusedRef.current = false
        setHomeFocused(false)
      }
    }, [router])
  )

  const sortedHosts = useMemo(() => sortHostsByLastConnected(hosts), [hosts])
  const sortedHostCatalog = useMemo(() => sortHostsByLastConnected(hostCatalog), [hostCatalog])
  // One clock for every agent count, so Feed, the Agents badge and each desktop agree.
  const now = useNow(30_000, homeFocused)
  const refetchHostAgents = useCallback((hostId: string) => {
    const entry = allClientsRef.current.find((candidate) => candidate.hostId === hostId)
    return entry?.client.getState() === 'connected'
      ? fetchHomeHostWorktreeInfo(entry.client, hostId, setWorktreeInfo, () => false)
      : Promise.resolve()
  }, [])
  const agentActivity = useAgentActivityWrites(connections.allClients, refetchHostAgents)
  const { pendingActivity } = agentActivity
  const agentList = useMemo<AgentListInput>(
    () => ({
      hosts: sortedHosts,
      hostStates: connections.hostStates,
      worktreeInfo,
      now,
      pendingActivity
    }),
    [sortedHosts, connections.hostStates, worktreeInfo, now, pendingActivity]
  )
  const agentsNeedingYou = useMemo(() => selectAgentsNeedingYou(agentList), [agentList])
  const needsYouByHost = useMemo(
    () => countAgentsNeedingYouByHost(agentsNeedingYou),
    [agentsNeedingYou]
  )
  const connectedHosts = useMemo(
    () => sortedHosts.filter((host) => connections.hostStates[host.id] === 'connected'),
    [sortedHosts, connections.hostStates]
  )
  // Before a desktop's first connect settles, "not connected" is not yet true.
  const hostsConnecting = hosts.some((host) => {
    const state = connections.hostStates[host.id]
    return state === undefined || state === 'connecting' || state === 'handshaking'
  })
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const stats = useMemo(() => totalHomeStats(statsByHost, hostIds), [statsByHost, hostIds])
  const hostConnections = useMemo(
    () => projectHomeHostConnections(connections.allClients),
    [connections.allClients]
  )

  return {
    ...connections,
    accountsByHost,
    applyAgentActivity: agentActivity.apply,
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
