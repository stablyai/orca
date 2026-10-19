import { useCallback, useEffect, useRef } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import { useFocusEffect } from 'expo-router'
import { setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'
import { useWorktreeResync } from '../transport/use-worktree-resync'
import { startHostWorktreeRefresh } from '../worktree/host-worktree-refresh'
import type { HostSidebarFeedTriggers } from './host-sidebar-feed-reader'
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
  /** Null in a build that lists without the feed. */
  sidebarFeed: HostSidebarFeedTriggers | null
  state: HostScreenState
  syncViewSettingsFromDesktop: (options?: { reconnected?: boolean }) => Promise<void>
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

  // Why beside worktree.ps, not inside it: a slow server must not hold back the desktop's own rows.
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
      // Why: prevent slow remote hosts from stacking overlapping worktree.ps requests during polling.
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
        // Why (STA-3123): a failed catalog request must not pass for "0 worktrees";
        // surface it so a broken remote host is diagnosable instead of looking empty.
        if (fetched.kind === 'request_failed') {
          setCatalogError(fetched.code)
          return
        }
        if (fetched.pending.admission.kind === 'invalid') {
          setCatalogError('invalid_response')
        }
        // Why: unchanged responses still yield the confirmed rows, so every poll reasserts
        // host truth over optimistic local edits regardless of payload size.
        const confirmed = worktreeCatalogRef.current.admit(fetched.pending)
        if (confirmed) {
          setCatalogError(null)
          // A confirmed list is the host answering, which is the evidence a transient action
          // failure was about a moment that has passed.
          setActionError('')
          // Why: reuse the existing array on identical snapshots to keep SectionList/sort rebuilds off the tap path.
          setWorktrees((current) =>
            areWorktreeListsEqual(current, confirmed) ? current : confirmed
          )
          setLastKnownWorktrees((current) =>
            areWorktreeListsEqual(current, confirmed) ? current : confirmed
          )
          setWorktreesLoaded(true)
          // Why (#8498): overwrite the home-written cache with the confirmed snapshot so a reconnect/remount can't serve a stale list.
          if (hostId) {
            setCachedWorktrees(hostId, confirmed, { proven: true })
          }
          // Drop the optimistic active override once the host reports it active, so later desktop changes win.
          setOptimisticActiveWorktreeIdentity((pending) =>
            clearConfirmedActiveWorktreeIdentity(pending, confirmed)
          )

          // Clear optimistic sleep overrides once the server confirms inactive (liveTerminalCount === 0).
          setSleptIds((prev) => retainLiveSleptWorktreeIdentities(prev, confirmed))

          // Sync pin state from server so desktop-initiated pins reflect without relying on stale AsyncStorage.
          // Switch point: a feed-built list keeps no pin cache of its own.
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
        // Will retry on reconnect
        if (clientRef.current === requestClient && hostId === requestHostId) {
          // Why the branch: this code is printed to the user verbatim, and a reply the reader
          // refused is a host-payload defect, not a connectivity one (STA-3123).
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
      // Why: focus nudges reconnect and probes a possibly half-open socket; empty deps fire per focus, not per state flip (which defeats backoff).
      // 'focus' keeps a healthy relay green — probe, never suspend (S2 grey blink).
      clientRef.current?.notifyForeground('focus')
    }, [])
  )

  const startWorktreeRefresh = useCallback(() => {
    if (!client || connState !== 'connected') {
      return
    }
    void syncViewSettingsFromDesktop()
    return startHostWorktreeRefresh({
      client,
      fetchWorktrees,
      fetchRepoMetadata,
      syncViewSettings: syncViewSettingsFromDesktop,
      sidebarFeed
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
      // The embedded sidebar isn't a routed screen (focus never fires); it refreshes via the mount effect below.
      if (!embedded) {
        return startWorktreeRefresh()
      }
    }, [embedded, startWorktreeRefresh])
  )

  // Why: the embedded sidebar is never the focused route, so wire its refresh lifecycle from a mount effect.
  useEffect(() => {
    if (embedded) {
      return startWorktreeRefresh()
    }
  }, [embedded, startWorktreeRefresh])

  // Why (#8498): steady-state polls miss the transition INTO 'connected' after background/sleep, when the cache is stalest.
  const { refreshing, onRefresh } = useWorktreeResync({
    client,
    connState,
    fetchWorktrees,
    fetchRepoMetadata
  })

  return { fetchWorktrees, onRefresh, refreshing }
}

export type HostWorktreeCatalog = ReturnType<typeof useHostWorktreeCatalog>
