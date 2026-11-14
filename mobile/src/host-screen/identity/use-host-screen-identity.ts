import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { translate } from '../../i18n/mobile-i18n'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../src/shared/sidebar-inputs-switch'
import { loadPinnedIds } from '../../storage/preferences'
import { loadHosts, peekHosts } from '../../host-catalog/host-store'
import { updateLastConnected } from '../../host-catalog/host-connection-history'
import type { HostProfile } from '../../host-catalog/host-profile'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { HostScreenState } from '../use-host-screen-state'
import { storedHostDescriptor } from './host-stored-identity'
import { INITIAL_MOBILE_VIEW } from '../../worktree/workspace-list/workspace-view-settings'
import { cachedHostView } from '../view-settings/host-view-memory'
import { cachedHostWorktrees } from '../catalog/host-list-queries'

// The host as last read this launch, so the title's first frame shows its name, not "Host".
export function peekStoredHost(hostId: string | undefined): HostProfile | null {
  return hostId ? (peekHosts()?.find((host) => host.id === hostId) ?? null) : null
}

export function useHostScreenIdentity(args: {
  client: RpcClient | null
  hostId: string | undefined
  state: HostScreenState
}): void {
  const { client, hostId, state } = args
  const queryClient = useQueryClient()
  const {
    clientRef,
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

  // Cache pins locally only without the feed; view settings come from ui.get.
  useEffect(() => {
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

  // Imperative callbacks read the current client without resubscribing.
  useEffect(() => {
    clientRef.current = client
  }, [client])

  useEffect(() => {
    const seedHost = peekStoredHost(hostId)
    setHostName(seedHost?.name ?? '')
    setHostStoredDescriptor(seedHost ? storedHostDescriptor(seedHost) : null)
    setError('')
    setRepoHostIdByRepoId(new Map())
    // Another desktop's Workspace options must not stand in until this one's are read.
    const seedView = cachedHostView(queryClient, hostId) ?? INITIAL_MOBILE_VIEW
    viewRef.current = seedView
    setView(seedView)
    setHostLabelById(new Map())
    setServedProjectSections(null)
    setDesktopRepos([])
    setHostHealthById(new Map())
    setHostPlatform(null)
    setShowPinnedInGroups(false)
    // Expo Router can reuse the screen for a new hostId; reseed because the state initializer runs only once.
    const freshCache = cachedHostWorktrees(queryClient, hostId)
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
        setError(translate('hostScreen.identity.hostNotFound', 'Host not found'))
        return
      }
      setHostName(host.name)
      setHostStoredDescriptor(storedHostDescriptor(host))
      void updateLastConnected(host.id)
    })
    return () => {
      stale = true
    }
  }, [hostId])
}
