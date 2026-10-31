import AsyncStorage from '@react-native-async-storage/async-storage'
import { useRouter, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import type { HostCatalogEntry } from '../transport/types'
import { fetchHomeHostWorktreeInfo } from '../worktree/home-host-worktree-fetch'
import {
  withoutHomeAgentStates,
  type HomeWorktreeSummary,
  type HostWorktreeInfo
} from '../worktree/home-worktree-info'
import {
  LAST_VISITED_WORKTREE_STORAGE_KEY,
  readLastVisitedWorktreeRecord
} from '../worktree/last-visited-worktree-repo'
import { selectHomeJumpBackInRows } from '../worktree/home-jump-back-in'
import { selectHomeResumeCard } from '../worktree/home-resume-card'
import { projectHomeHostConnections } from './home-host-connection-projection'
import { useMobileHomeHostConnections } from './use-mobile-home-host-connections'

export function useMobileHomeData() {
  const router = useRouter()
  const [hostCatalog, setHostCatalog] = useState<HostCatalogEntry[]>([])
  // Until the catalog read lands, an empty list says nothing; a paired user must not see first-run.
  const [hostCatalogLoaded, setHostCatalogLoaded] = useState(false)
  const [worktreeInfo, setWorktreeInfo] = useState<Record<string, HostWorktreeInfo>>({})
  const [lastVisited, setLastVisited] = useState<{ hostId: string; worktreeId: string } | null>(
    null
  )
  const onboardingCheckedRef = useRef(false)
  const hydratedRef = useRef(false)
  const focusedRef = useRef(false)
  const isHomeFocused = useCallback(() => focusedRef.current, [])
  const hosts = useMemo(() => selectConnectableHostProfiles(hostCatalog), [hostCatalog])
  const connections = useMobileHomeHostConnections(
    hosts,
    hostCatalog,
    setWorktreeInfo,
    isHomeFocused
  )
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
      saveHomeSnapshot({ worktreeInfo, savedAt: Date.now() })
    }
  }, [worktreeInfo])

  useEffect(() => {
    allClientsRef.current = connections.allClients
  }, [connections.allClients])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      focusedRef.current = true
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
      void AsyncStorage.getItem(LAST_VISITED_WORKTREE_STORAGE_KEY).then((raw) => {
        if (!stale) {
          setLastVisited(readLastVisitedWorktreeRecord(raw))
        }
      })
      for (const entry of allClientsRef.current) {
        if (entry.client.getState() === 'connected') {
          void fetchHomeHostWorktreeInfo(entry.client, entry.hostId, setWorktreeInfo, () => stale)
        }
      }
      return () => {
        stale = true
        focusedRef.current = false
      }
    }, [router])
  )

  const sortedHosts = useMemo(() => sortHostsByLastConnected(hosts), [hosts])
  const sortedHostCatalog = useMemo(() => sortHostsByLastConnected(hostCatalog), [hostCatalog])
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
  const jumpBackInRows = useMemo(
    () =>
      selectHomeJumpBackInRows({
        hosts: sortedHosts,
        hostStates: connections.hostStates,
        worktreeInfo,
        resumeCard
      }),
    [sortedHosts, connections.hostStates, worktreeInfo, resumeCard]
  )
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
    connectedHosts,
    hostCatalog,
    hostCatalogLoaded,
    hostConnections,
    jumpBackInRows,
    router,
    setHostCatalog,
    sortedHostCatalog,
    worktreeInfo
  }
}
