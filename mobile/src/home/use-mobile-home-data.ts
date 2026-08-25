import AsyncStorage from '@react-native-async-storage/async-storage'
import { useRouter, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AccountsSnapshot } from '../components/AccountUsage'
import { hasRenderableUsage } from '../components/AccountUsage'
import { loadHomeSnapshot, saveHomeSnapshot } from '../cache/home-snapshot-cache'
import { getCachedWorktrees, setCachedWorktrees } from '../cache/worktree-cache'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination
} from '../onboarding/mobile-onboarding-plan'
import { totalHomeStats, type HomeStatsSummary } from '../stats/home-stats-total'
import type { TaskProvider } from '../tasks/mobile-task-providers'
import { selectConnectableHostProfiles } from '../transport/host-catalog-selection'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry, HostProfile } from '../transport/types'
import { fetchHomeHostWorktreeInfo } from '../worktree/home-host-worktree-fetch'
import type { HomeWorktreeSummary, HostWorktreeInfo } from '../worktree/home-worktree-info'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  readLastVisitedWorktreeRecord
} from '../worktree/last-visited-worktree-repo'
import { selectHomeResumeCard } from '../worktree/home-resume-card'
import {
  fetchMobileHomeAccounts,
  fetchMobileHomeStats,
  fetchMobileHomeTaskProviders
} from './mobile-home-host-requests'
import { useMobileHomeHostConnections } from './use-mobile-home-host-connections'

export function useMobileHomeData() {
  const router = useRouter()
  const [hostCatalog, setHostCatalog] = useState<HostCatalogEntry[]>([])
  const [statsByHost, setStatsByHost] = useState<Record<string, HomeStatsSummary>>({})
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [accountsByHost, setAccountsByHost] = useState<Record<string, AccountsSnapshot>>({})
  const [taskProvidersByHost, setTaskProvidersByHost] = useState<Record<string, TaskProvider[]>>({})
  const [lastVisited, setLastVisited] = useState<{ hostId: string; worktreeId: string } | null>(
    null
  )
  const onboardingCheckedRef = useRef(false)
  const hydratedRef = useRef(false)
  const hosts = useMemo(() => selectConnectableHostProfiles(hostCatalog), [hostCatalog])
  const connections = useMobileHomeHostConnections(hosts, hostCatalog, {
    setStats: setStatsByHost,
    setWorktreeInfo,
    setAccounts: setAccountsByHost,
    setTaskProviders: setTaskProvidersByHost
  })
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
        Object.keys(previous).length > 0 ? previous : snapshot.worktreeInfo
      )
      setAccountsByHost((previous) =>
        Object.keys(previous).length > 0 ? previous : snapshot.accountsByHost
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
    if (Object.keys(worktreeInfo).length > 0 || Object.keys(accountsByHost).length > 0) {
      saveHomeSnapshot({ worktreeInfo, accountsByHost, savedAt: Date.now() })
    }
  }, [worktreeInfo, accountsByHost])

  useEffect(() => {
    allClientsRef.current = connections.allClients
  }, [connections.allClients])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      void loadHostCatalog().then(async (catalog) => {
        if (stale) {
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
      void AsyncStorage.getItem(LAST_VISITED_WORKTREE_STORAGE_KEY).then((raw) => {
        if (!stale) {
          setLastVisited(readLastVisitedWorktreeRecord(raw))
        }
      })
      for (const entry of allClientsRef.current) {
        if (entry.client.getState() === 'connected') {
          fetchMobileHomeStats(entry.client, entry.hostId, setStatsByHost, () => stale)
          void fetchHomeHostWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => stale)
          fetchMobileHomeAccounts(entry.client, entry.hostId, setAccountsByHost, () => stale)
          fetchMobileHomeTaskProviders(
            entry.client,
            entry.hostId,
            setTaskProvidersByHost,
            () => stale
          )
        }
      }
      return () => {
        stale = true
      }
    }, [router])
  )

  const sortedHosts = useMemo(
    () => hosts.toSorted((left, right) => right.lastConnected - left.lastConnected),
    [hosts]
  )
  const sortedHostCatalog = useMemo(
    () => hostCatalog.toSorted((left, right) => right.lastConnected - left.lastConnected),
    [hostCatalog]
  )
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const stats = useMemo(() => totalHomeStats(statsByHost, hostIds), [statsByHost, hostIds])
  const resumeCard = useMemo(
    () =>
      selectHomeResumeCard({
        hosts: sortedHosts,
        hostStates: connections.hostStates,
        worktreeInfo,
        lastVisited,
        cachedWorktrees: (hostId) => getCachedWorktrees(hostId) as HomeWorktreeSummary[] | null
      }),
    [sortedHosts, connections.hostStates, worktreeInfo, lastVisited]
  )
  const accountsHosts = useMemo(() => {
    const items: { host: HostProfile; snapshot: AccountsSnapshot }[] = []
    for (const host of sortedHosts) {
      const snapshot = accountsByHost[host.id]
      if (
        connections.hostStates[host.id] === 'connected' &&
        snapshot &&
        (hasRenderableUsage(snapshot, 'claude') || hasRenderableUsage(snapshot, 'codex'))
      ) {
        items.push({ host, snapshot })
      }
    }
    return items
  }, [sortedHosts, connections.hostStates, accountsByHost])
  const connectedHosts = useMemo(
    () => sortedHosts.filter((host) => connections.hostStates[host.id] === 'connected'),
    [sortedHosts, connections.hostStates]
  )
  const primaryHost = connectedHosts[0] ?? null
  const primaryTaskProviders = primaryHost
    ? (taskProvidersByHost[primaryHost.id] ?? ['github'])
    : []
  const hostPaths = Object.fromEntries(
    connections.allClients.map(({ hostId, path }) => [hostId, path])
  )
  const hostPendingPaths = Object.fromEntries(
    connections.allClients.map(({ hostId, pendingPath }) => [hostId, pendingPath])
  )
  const hostPairingRejected = Object.fromEntries(
    connections.allClients.map(({ hostId, pairingRejected }) => [hostId, pairingRejected])
  )

  return {
    ...connections,
    accountsHosts,
    connectedHosts,
    hostCatalog,
    hostPairingRejected,
    hostPaths,
    hostPendingPaths,
    primaryHost,
    primaryTaskProviders,
    resumeCard,
    router,
    setHostCatalog,
    sortedHostCatalog,
    stats,
    worktreeInfo
  }
}
