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
import { totalHomeStats, type HomeStatsRow } from '../stats/home-stats-total'
import type { TaskProvider } from '../../../src/shared/task-providers'
import { selectConnectableHostProfiles } from '../transport/host-catalog-selection'
import { loadHostCatalog, reorderHosts } from '../transport/host-store'
import { orderHostsByIds } from '../transport/host-list-order'
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
import { projectHomeHostConnections } from './home-host-connection-projection'
import { useMobileHomeHostConnections } from './use-mobile-home-host-connections'

export function useMobileHomeData() {
  const router = useRouter()
  const [hostCatalog, setHostCatalog] = useState<HostCatalogEntry[]>([])
  const [statsByHost, setStatsByHost] = useState<Record<string, HomeStatsRow>>({})
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [accountsByHost, setAccountsByHost] = useState<Record<string, AccountsSnapshot>>({})
  const [taskProvidersByHost, setTaskProvidersByHost] = useState<Record<string, TaskProvider[]>>({})
  const [lastVisited, setLastVisited] = useState<{ hostId: string; worktreeId: string } | null>(
    null
  )
  const catalogEditRevisionRef = useRef(0)
  const catalogReadRevisionRef = useRef(0)
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

  // Every catalog read uses the same fence, including pairing rechecks and removal refreshes.
  const refreshHostCatalog = useCallback(async (isStale: () => boolean = () => false) => {
    const editRevision = catalogEditRevisionRef.current
    const readRevision = ++catalogReadRevisionRef.current
    const catalog = await loadHostCatalog()
    if (
      isStale() ||
      catalogEditRevisionRef.current !== editRevision ||
      catalogReadRevisionRef.current !== readRevision
    ) {
      return null
    }
    setHostCatalog(catalog)
    return catalog
  }, [])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      void refreshHostCatalog(() => stale).then(async (catalog) => {
        if (!catalog) {
          return
        }
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
    }, [router, refreshHostCatalog])
  )

  // Pairing appends; metadata/status changes preserve this durable, user-chosen order.
  const sortedHosts = hosts
  const sortedHostCatalog = hostCatalog
  const reorderHostCatalog = useCallback(
    async (orderedIds: string[]) => {
      const revision = ++catalogEditRevisionRef.current
      setHostCatalog((current) => orderHostsByIds(current, orderedIds))
      try {
        await reorderHosts(orderedIds)
      } catch (error) {
        if (catalogEditRevisionRef.current === revision) {
          await refreshHostCatalog()
        }
        throw error
      }
      if (catalogEditRevisionRef.current === revision) {
        await refreshHostCatalog()
      }
    },
    [refreshHostCatalog]
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
  const hostConnections = useMemo(
    () => projectHomeHostConnections(connections.allClients),
    [connections.allClients]
  )

  return {
    ...connections,
    accountsHosts,
    connectedHosts,
    hostCatalog,
    hostConnections,
    resumeCard,
    reorderHostCatalog,
    router,
    refreshHostCatalog,
    sortedHostCatalog,
    stats,
    taskProvidersByHost,
    worktreeInfo
  }
}
