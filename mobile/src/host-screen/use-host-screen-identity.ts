import { useEffect } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import { getCachedWorktrees } from '../cache/worktree-cache'
import { loadPinnedIds } from '../storage/preferences'
import { loadHosts, updateLastConnected } from '../transport/host-store'
import type { RpcClient } from '../transport/rpc-client'
import type { Worktree } from '../worktree/workspace-list-sections'
import type { HostScreenState } from './use-host-screen-state'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'

export function useHostScreenIdentity(args: {
  client: RpcClient | null
  hostId: string | undefined
  state: HostScreenState
}): void {
  const { client, hostId, state } = args
  const {
    clientRef,
    repoMetadataFetchedAtRef,
    setCatalogError,
    setError,
    setHostLabelById,
    setServedProjectSections,
    setDesktopRepos,
    setHostHealthById,
    setHostName,
    setHostPlatform,
    setHostStoredDescriptor,
    setLastKnownWorktrees,
    setPinnedIds,
    setRepoHostIdByRepoId,
    setView,
    viewRef,
    setShowPinnedInGroups,
    setWorktrees,
    setWorktreesLoaded
  } = state

  // Load persisted pins from local cache; view settings are no longer local (they sync via ui.get).
  useEffect(() => {
    // Switch point: a feed-built list takes pins from the host alone.
    if (!hostId || ORCA_SIDEBAR_INPUTS_IS_MAIN) {
      return
    }
    let stale = false
    void (async () => {
      const pins = await loadPinnedIds(hostId)
      if (stale) {
        return
      }
      setPinnedIds(pins)
    })()
    return () => {
      stale = true
    }
  }, [hostId])

  // Why: mirror client into a ref so imperative call sites read it without re-subscribing.
  useEffect(() => {
    clientRef.current = client
  }, [client])

  useEffect(() => {
    setHostName('')
    setHostStoredDescriptor(null)
    setError('')
    setRepoHostIdByRepoId(new Map())
    // Another desktop's Workspace options must not stand in until this one's are read.
    viewRef.current = INITIAL_MOBILE_VIEW
    setView(INITIAL_MOBILE_VIEW)
    setHostLabelById(new Map())
    setServedProjectSections(null)
    setDesktopRepos([])
    setHostHealthById(new Map())
    setHostPlatform(null)
    setShowPinnedInGroups(false)
    repoMetadataFetchedAtRef.current = 0
    // Why: useState initializer runs only on first mount, so re-seed the cache when Expo Router reuses this screen for a new hostId.
    const freshCache = hostId ? (getCachedWorktrees(hostId) as Worktree[] | null) : null
    setCatalogError(null)
    if (freshCache) {
      setWorktrees(freshCache)
      setLastKnownWorktrees(freshCache)
      setWorktreesLoaded(true)
    } else {
      setWorktreesLoaded(false)
      setWorktrees([])
      setLastKnownWorktrees([])
    }
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }
      setHostName(host.name)
      setHostStoredDescriptor({
        ...(host.personalName !== undefined ? { personalName: host.personalName } : {}),
        ...(host.lastKnownMachineName !== undefined
          ? { lastKnownMachineName: host.lastKnownMachineName }
          : {}),
        ...(host.lastKnownHostPlatform !== undefined
          ? { lastKnownHostPlatform: host.lastKnownHostPlatform }
          : {})
      })
      void updateLastConnected(host.id)
    })
    return () => {
      stale = true
    }
  }, [hostId])
}
