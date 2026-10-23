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
import {
  selectConnectableHostProfiles,
  sortHostsByLastConnected
} from '../transport/host-catalog-selection'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry, HostProfile } from '../transport/types'
import { fetchHomeHostWorktreeInfo } from '../worktree/home-host-worktree-fetch'
import type { HomeWorktreeSummary, HostWorktreeInfo } from '../worktree/home-worktree-info'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  readLastVisitedWorktreeRecord
} from '../worktree/last-visited-worktree-repo'
import {
  selectHomeJumpBackIn,
  selectHomeNeedsYou,
  type HomeResumeCardInput
} from '../worktree/home-resume-card'
import { fetchMobileHomeAccounts } from './mobile-home-host-requests'
import { projectHomeHostConnections } from './home-host-connection-projection'
import { useMobileHomeHostConnections } from './use-mobile-home-host-connections'

// Why: who is waiting and who is working are live claims; only this session's fetch may make them.
function withoutLiveActivity(
  byHost: Record<string, HostWorktreeInfo>
): Record<string, HostWorktreeInfo> {
  return Object.fromEntries(
    Object.entries(byHost).map(([hostId, info]) => [
      hostId,
      { ...info, permissionWorktrees: undefined, workingAgentCount: undefined }
    ])
  )
}

export function useMobileHomeData() {
  const router = useRouter()
  const [hostCatalog, setHostCatalog] = useState<HostCatalogEntry[]>([])
  // Why: the catalog starts empty, so without this a paired user sees the first-run screen until
  // the secure-store read lands.
  const [hostCatalogLoaded, setHostCatalogLoaded] = useState(false)
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [accountsByHost, setAccountsByHost] = useState<Record<string, AccountsSnapshot>>({})
  const [lastVisited, setLastVisited] = useState<{ hostId: string; worktreeId: string } | null>(
    null
  )
  const onboardingCheckedRef = useRef(false)
  const hydratedRef = useRef(false)
  const hosts = useMemo(() => selectConnectableHostProfiles(hostCatalog), [hostCatalog])
  const connections = useMobileHomeHostConnections(hosts, hostCatalog, {
    setWorktreeInfo,
    setAccounts: setAccountsByHost
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
        Object.keys(previous).length > 0 ? previous : withoutLiveActivity(snapshot.worktreeInfo)
      )
      setAccountsByHost((previous) =>
        Object.keys(previous).length > 0 ? previous : snapshot.accountsByHost
      )
      for (const [hostId, info] of Object.entries(snapshot.worktreeInfo)) {
        const remembered = [
          ...(info.lastActiveWorktree ? [info.lastActiveWorktree] : []),
          ...(info.recentWorktrees ?? []).filter(
            (worktree) => worktree.worktreeId !== info.lastActiveWorktree?.worktreeId
          )
        ]
        if (remembered.length > 0) {
          setCachedWorktrees(hostId, remembered)
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
      void loadHostCatalog()
        .then(async (catalog) => {
          if (stale) {
            return
          }
          setHostCatalog(catalog)
          setHostCatalogLoaded(true)
          if (catalog.length === 0 || onboardingCheckedRef.current) {
            return
          }
          onboardingCheckedRef.current = true
          const steps = await loadMobileOnboardingSteps()
          if (!stale && steps.length > 0) {
            router.replace(mobileOnboardingDestination(steps))
          }
        })
        .catch(() => {
          // An unreadable catalog shows what it always did, the first-run screen, not a spinner.
          if (!stale) {
            setHostCatalogLoaded(true)
          }
        })
      void AsyncStorage.getItem(LAST_VISITED_WORKTREE_STORAGE_KEY).then((raw) => {
        if (!stale) {
          setLastVisited(readLastVisitedWorktreeRecord(raw))
        }
      })
      for (const entry of allClientsRef.current) {
        if (entry.client.getState() === 'connected') {
          void fetchHomeHostWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => stale)
          fetchMobileHomeAccounts(entry.client, entry.hostId, setAccountsByHost, () => stale)
        }
      }
      return () => {
        stale = true
      }
    }, [router])
  )

  const sortedHosts = useMemo(() => sortHostsByLastConnected(hosts), [hosts])
  const sortedHostCatalog = useMemo(() => sortHostsByLastConnected(hostCatalog), [hostCatalog])
  const { needsYou, jumpBackIn, workingAgentCount } = useMemo(() => {
    const input: HomeResumeCardInput = {
      hosts: sortedHosts,
      hostStates: connections.hostStates,
      worktreeInfo,
      lastVisited,
      cachedWorktrees: (hostId) => getCachedWorktrees(hostId) as HomeWorktreeSummary[] | null
    }
    const waiting = selectHomeNeedsYou(input)
    let working = 0
    for (const host of sortedHosts) {
      const info = worktreeInfo[host.id]
      if (connections.hostStates[host.id] === 'connected' && info && !info.catalogUnavailable) {
        working += info.workingAgentCount ?? 0
      }
    }
    return {
      needsYou: waiting,
      jumpBackIn: selectHomeJumpBackIn(input, waiting),
      workingAgentCount: working
    }
  }, [sortedHosts, connections.hostStates, worktreeInfo, lastVisited])
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
    hostCatalogLoaded,
    hostConnections,
    jumpBackIn,
    needsYou,
    router,
    setHostCatalog,
    sortedHostCatalog,
    workingAgentCount,
    worktreeInfo
  }
}
