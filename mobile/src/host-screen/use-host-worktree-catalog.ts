import { useCallback, useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import { useFocusEffect } from 'expo-router'
import { setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'
import { useWorktreeResync } from '../transport/use-worktree-resync'
import { startHostWorktreeRefresh } from '../worktree/host-worktree-refresh'
import type { HostSidebarFeedTriggers } from './host-sidebar-feed-connection'
import { areWorktreeListsEqual } from '../worktree/worktree-list-snapshot'
import {
  clearConfirmedActiveWorktreeIdentity,
  retainLiveSleptWorktreeIdentities
} from '../worktree/worktree-host-row-identity'
import { savePinnedIds } from '../storage/preferences'
import type { FetchHostRepoMetadata } from './use-host-repo-metadata'
import type { HostScreenState } from './use-host-screen-state'
import { relaysToServers } from '../transport/execution-host-scoped-rpc-client'
import {
  applyServerWorkspaces,
  fetchServerWorkspaces,
  NO_SERVER_WORKSPACES
} from '../worktree/server-workspaces'

export function useHostWorktreeCatalog(args: {
  client: RpcClient | null
  connState: ConnectionState
  embedded: boolean
  fetchRepoMetadata: FetchHostRepoMetadata
  hostCapabilities: readonly string[]
  hostId: string | undefined
  sidebarFeed: HostSidebarFeedTriggers | null
  state: HostScreenState
  syncViewSettingsFromDesktop: (options?: { resend?: boolean }) => Promise<void>
}) {
  const {
    client,
    connState,
    embedded,
    fetchRepoMetadata,
    hostCapabilities,
    hostId,
    sidebarFeed,
    state,
    syncViewSettingsFromDesktop
  } = args
  const {
    clientRef,
    fetchWorktreesInFlightRef,
    newWorktreeModalVisibleRef,
    setActionError,
    setCatalogError,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    setServerWorkspaces,
    setSleptIds,
    setWorktrees,
    setWorktreesLoaded,
    worktreeCatalogRef
  } = state
  // Keyed by client: a fetch still running on a replaced client must not skip the new one's.
  const serverFetchInFlightRef = useRef<RpcClient | null>(null)

  // Fetch server rows separately so a slow server cannot delay desktop rows.
  const fetchServerRows = useCallback(
    async (requestClient: RpcClient) => {
      if (!relaysToServers(requestClient, hostCapabilities)) {
        // An older desktop or shell: today's view, and no rows that could not open.
        setServerWorkspaces(NO_SERVER_WORKSPACES)
        return
      }
      if (serverFetchInFlightRef.current === requestClient) {
        return
      }
      serverFetchInFlightRef.current = requestClient
      try {
        const fetched = await fetchServerWorkspaces(requestClient)
        if (fetched && clientRef.current === requestClient) {
          setServerWorkspaces((previous) => applyServerWorkspaces(previous, fetched))
        }
      } catch {
        // Keeps the rows shown; the next poll retries.
      } finally {
        if (serverFetchInFlightRef.current === requestClient) {
          serverFetchInFlightRef.current = null
        }
      }
    },
    [hostCapabilities]
  )

  // A re-read asked for during a flight: that flight may predate the change that asked.
  const fetchWorktreesQueuedRef = useRef(false)
  const fetchWorktrees = useCallback(
    async (options: { allowDuringModal?: boolean; queueIfInFlight?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId) {
        return
      }
      if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
        return
      }
      // Coalesce overlapping polls so slow remote hosts cannot accumulate worktree.ps requests.
      if (fetchWorktreesInFlightRef.current) {
        fetchWorktreesQueuedRef.current ||= options.queueIfInFlight === true
        return
      }
      fetchWorktreesInFlightRef.current = true
      const requestClient = client
      const requestHostId = hostId
      void fetchServerRows(requestClient)

      try {
        const fetched = await worktreeCatalogRef.current.fetch(requestClient, requestHostId)
        if (clientRef.current !== requestClient || hostId !== requestHostId) {
          return
        }
        if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
          return
        }
        // Report catalog failure rather than zero workspaces so broken remote hosts remain diagnosable (STA-3123).
        if (fetched.kind === 'request_failed') {
          setCatalogError(fetched.code)
          return
        }
        if (fetched.pending.admission.kind === 'invalid') {
          setCatalogError('invalid_response')
        }
        // Even unchanged replies reassert host truth over optimistic local edits.
        const confirmed = worktreeCatalogRef.current.admit(fetched.pending)
        if (confirmed) {
          setCatalogError(null)
          // A confirmed catalog proves a transient action failure is no longer current.
          setActionError('')
          // Reuse identical snapshot arrays to avoid rebuilding SectionList/sorts on the tap path.
          setWorktrees((current) =>
            areWorktreeListsEqual(current, confirmed) ? current : confirmed
          )
          setLastKnownWorktrees((current) =>
            areWorktreeListsEqual(current, confirmed) ? current : confirmed
          )
          setWorktreesLoaded(true)
          // Replace the home-written cache with confirmed data so reconnect/remount cannot restore stale rows (#8498).
          if (hostId) {
            setCachedWorktrees(hostId, confirmed, { proven: true })
          }
          // Drop the optimistic active override once the host reports it active, so later desktop changes win.
          setOptimisticActiveWorktreeIdentity((pending) =>
            clearConfirmedActiveWorktreeIdentity(pending, confirmed)
          )

          // Clear optimistic sleep overrides once the server confirms inactive (liveTerminalCount === 0).
          setSleptIds((prev) => retainLiveSleptWorktreeIdentities(prev, confirmed))

          // Sync server pins only without the feed; feed-built lists keep no local pin cache.
          const serverPinned = new Set(confirmed.filter((w) => w.isPinned).map((w) => w.worktreeId))
          if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
            setPinnedIds((prev) => {
              if (
                serverPinned.size === prev.size &&
                [...serverPinned].every((id) => prev.has(id))
              ) {
                return prev
              }
              if (hostId) {
                void savePinnedIds(hostId, serverPinned)
              }
              return serverPinned
            })
          }
        }
      } catch (error) {
        if (clientRef.current === requestClient && hostId === requestHostId) {
          // Distinguish refused host payloads from connectivity failures; this code is shown verbatim (STA-3123).
          setCatalogError(
            error instanceof RpcIncompatibleReplyError ? 'invalid_response' : 'network_error'
          )
        }
      } finally {
        fetchWorktreesInFlightRef.current = false
        if (fetchWorktreesQueuedRef.current) {
          fetchWorktreesQueuedRef.current = false
          // The latest render's fetch, without this flight's modal override: the client may have changed.
          void fetchWorktreesRef.current({ queueIfInFlight: true })
        }
      }
    },
    [client, connState, hostId, fetchServerRows]
  )
  const fetchWorktreesRef = useRef(fetchWorktrees)
  useEffect(() => {
    fetchWorktreesRef.current = fetchWorktrees
  }, [fetchWorktrees])

  useFocusEffect(
    useCallback(() => {
      // Focus must probe half-open sockets without suspending healthy relay sessions; state-dependent focus callbacks would defeat reconnect backoff.
      clientRef.current?.notifyForeground('focus')
    }, [])
  )

  const startWorktreeRefresh = useCallback(() => {
    if (!client || connState !== 'connected') {
      return
    }
    return startHostWorktreeRefresh({
      client,
      fetchWorktrees,
      fetchRepoMetadata,
      syncViewSettings: syncViewSettingsFromDesktop,
      sidebarFeed,
      appState: AppState
    })
  }, [
    client,
    connState,
    fetchWorktrees,
    fetchRepoMetadata,
    syncViewSettingsFromDesktop,
    sidebarFeed
  ])

  useFocusEffect(
    useCallback(() => {
      if (!embedded) {
        return startWorktreeRefresh()
      }
    }, [embedded, startWorktreeRefresh])
  )

  // Embedded sidebars never receive route focus; start their refresh lifecycle on mount.
  useEffect(() => {
    if (embedded) {
      return startWorktreeRefresh()
    }
  }, [embedded, startWorktreeRefresh])

  // Refresh on transition to connected; steady polls can miss the stalest post-sleep cache (#8498).
  const { refreshing, onRefresh } = useWorktreeResync({
    client,
    connState,
    fetchWorktrees,
    fetchRepoMetadata
  })

  return { fetchWorktrees, onRefresh, refreshing }
}

export type HostWorktreeCatalog = ReturnType<typeof useHostWorktreeCatalog>
