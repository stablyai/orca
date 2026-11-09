import { WORKTREE_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY } from '../../../src/shared/worktree-runtime-capabilities'
import { readWorktreeFirstPage } from '../worktree/worktree-catalog-first-page'
import type { Worktree } from '../worktree/workspace-list-types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import { useFocusEffect } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'
import { RpcIncompatibleReplyError } from '../transport/rpc/rpc-incompatible-reply-error'
import { startHostWorktreeRefresh } from '../worktree/host-worktree-refresh'
import type { HostSidebarFeedTriggers } from './host-sidebar-feed-connection'
import { areWorktreeListsEqual } from '../worktree/worktree-list-snapshot'
import {
  clearConfirmedActiveWorktreeIdentity,
  retainLiveSleptWorktreeIdentities
} from '../worktree/worktree-host-row-identity'
import { savePinnedIds } from '../storage/preferences'
import type { HostScreenState } from './use-host-screen-state'
import { relaysToServers } from '../worktree/execution-host-scoped-rpc-client'
import { NO_SERVER_WORKSPACES } from '../worktree/server-workspaces'
import { WorktreeCatalogReadError } from '../worktree/worktree-catalog-snapshot-client'
import { useHostQuery } from '../query/host-query'
import { hostReadClient } from '../query/host-read-client'
import { hostScopeKey } from '../query/host-query-key'
import { isHostNotConnectedError } from '../query/host-query-errors'
import { refetchHostQueryAfterInFlight } from '../query/host-event-router'
import {
  isHostListQuery,
  HOST_LIST_BACKSTOP_POLL_MS,
  HOST_LIST_POLL_MS,
  HOST_LIST_TARGET,
  hostServerWorkspacesInput,
  hostServerWorkspacesQuery,
  hostWorktreeCatalogKey,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from './host-list-queries'

// Shown verbatim so broken remote hosts stay diagnosable instead of looking empty (STA-3123).
function catalogErrorCode(error: unknown): string | null {
  if (isHostNotConnectedError(error)) {
    return null
  }
  if (error instanceof WorktreeCatalogReadError) {
    return error.code
  }
  return error instanceof RpcIncompatibleReplyError ? 'invalid_response' : 'network_error'
}

export function useHostWorktreeCatalog(args: {
  client: RpcClient | null
  connState: ConnectionState
  embedded: boolean
  hostCapabilities: readonly string[]
  // Whether the host answered its status: capabilities are unknown, not absent, until it has.
  hostStatusReadable: boolean
  hostId: string | undefined
  sidebarFeed: HostSidebarFeedTriggers | null
  state: HostScreenState
  syncViewSettingsFromDesktop: (options?: { resend?: boolean }) => Promise<void>
}) {
  const {
    client,
    connState,
    embedded,
    hostCapabilities,
    hostStatusReadable,
    hostId,
    sidebarFeed,
    state,
    syncViewSettingsFromDesktop
  } = args
  const {
    catalogError,
    clientRef,
    setActionError,
    setCatalogError,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    setServerWorkspaces,
    setSleptIds,
    setWorktrees,
    setWorktreesLoaded,
    showNewWorktree,
    worktrees,
    worktreesLoaded
  } = state
  const queryClient = useQueryClient()
  // Embedded sidebars never receive route focus; a routed list reads only while it is on top.
  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      // Focus must probe half-open sockets without suspending healthy relay sessions; state-dependent focus callbacks would defeat reconnect backoff.
      clientRef.current?.notifyForeground('focus')
      return () => setFocused(false)
    }, [])
  )
  const subscribed = embedded || focused

  const host = { hostId: hostId ?? '', client }
  // The host's sidebar feed replaces the poll: its notices say when a row changed.
  const pollMs = sidebarFeed ? false : HOST_LIST_POLL_MS
  const catalog = useHostQuery(
    hostWorktreeCatalogQuery,
    host,
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    {
      enabled: !!hostId,
      subscribed,
      refetchInterval:
        pollMs && hostCapabilities.includes(WORKTREE_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY)
          ? HOST_LIST_BACKSTOP_POLL_MS
          : pollMs
    }
  )
  // An older desktop or shell lists no server rows, rather than rows that could not open.
  const relays = client !== null && relaysToServers(client, hostCapabilities)
  // Until the host's status is read, stored server rows paint and nothing reads them.
  const relaysRuledOut = hostStatusReadable && !relays
  const servers = useHostQuery(
    hostServerWorkspacesQuery,
    host,
    HOST_LIST_TARGET,
    hostServerWorkspacesInput(hostStatusReadable ? hostCapabilities : null),
    // Execution hosts' notices are not relayed, so server rows keep the full poll.
    { enabled: !!hostId && relays, subscribed, refetchInterval: pollMs }
  )

  // Set by a read the new-workspace sheet asked for; other reads wait for the sheet to close.
  const applyDuringModalRef = useRef(false)
  // The first page drawn while the full catalog was out, until a confirmed catalog replaces it.
  const firstPageRef = useRef<Worktree[] | null>(null)
  // Even unchanged replies reassert host truth over optimistic local edits.
  useEffect(() => {
    const confirmedSnapshot = catalog.data
    if (!confirmedSnapshot || !hostId) {
      return
    }
    if (showNewWorktree && !applyDuringModalRef.current) {
      return
    }
    applyDuringModalRef.current = false
    // A copy: screens may sort the list in place, and the cache's rows are the next delta's base.
    const confirmed = [...confirmedSnapshot.worktrees]
    // Confirmed rows may keep the first page's array; a later failed read must not clear them.
    firstPageRef.current = null
    setCatalogError(null)
    // A confirmed catalog proves a transient action failure is no longer current.
    setActionError('')
    // Reuse identical snapshot arrays to avoid rebuilding SectionList/sorts on the tap path.
    setWorktrees((current) => (areWorktreeListsEqual(current, confirmed) ? current : confirmed))
    setLastKnownWorktrees((current) =>
      areWorktreeListsEqual(current, confirmed) ? current : confirmed
    )
    setWorktreesLoaded(true)
    // Drop the optimistic active override once the host reports it active, so later desktop changes win.
    setOptimisticActiveWorktreeIdentity((pending) =>
      clearConfirmedActiveWorktreeIdentity(pending, confirmed)
    )
    // Clear optimistic sleep overrides once the server confirms inactive (liveTerminalCount === 0).
    setSleptIds((prev) => retainLiveSleptWorktreeIdentities(prev, confirmed))
    // Sync server pins only without the feed; feed-built lists keep no local pin cache.
    if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
      const serverPinned = new Set(confirmed.filter((w) => w.isPinned).map((w) => w.worktreeId))
      setPinnedIds((prev) => {
        if (serverPinned.size === prev.size && [...serverPinned].every((id) => prev.has(id))) {
          return prev
        }
        void savePinnedIds(hostId, serverPinned)
        return serverPinned
      })
    }
  }, [catalog.data, catalog.dataUpdatedAt, hostId, showNewWorktree])

  // A first page only helps a never-loaded empty screen whose full read is not already failing.
  const firstPageUseful = !worktreesLoaded && worktrees.length === 0 && catalogError === null
  const readingFirstPage = catalog.data === undefined && catalog.isFetching && firstPageUseful
  // With nothing to show yet, draw the host's first rows while the full catalog arrives.
  useEffect(() => {
    if (!readingFirstPage || !client) {
      return
    }
    let current = true
    // Fails fast while connecting; the connected edge's catalog read asks again.
    void readWorktreeFirstPage(hostReadClient(client))
      .then((rows) => {
        if (rows && current) {
          firstPageRef.current = rows
          setWorktrees((shown) => (shown.length === 0 ? rows : shown))
        }
      })
      .catch(() => {})
    return () => {
      current = false
    }
  }, [readingFirstPage, client])

  useEffect(() => {
    // errorUpdatedAt outlives the error: a later success clears only `error`.
    if (catalog.status !== 'error') {
      return
    }
    const code = catalogErrorCode(catalog.error)
    if (code === null) {
      return
    }
    setCatalogError(code)
    // A failed full read must not leave the first page looking like the whole host.
    setWorktrees((shown) => (shown === firstPageRef.current ? [] : shown))
  }, [catalog.status, catalog.errorUpdatedAt])

  useEffect(() => {
    if (servers.data && !relaysRuledOut) {
      setServerWorkspaces(servers.data)
    } else if (!relays) {
      // Also drops a previous host's rows when the sidebar switches to one with none stored.
      setServerWorkspaces(NO_SERVER_WORKSPACES)
    }
  }, [relays, relaysRuledOut, servers.data])

  const fetchWorktrees = useCallback(
    async (options: { allowDuringModal?: boolean } = {}) => {
      if (!hostId) {
        return
      }
      const query = queryClient
        .getQueryCache()
        .find({ queryKey: hostWorktreeCatalogKey(hostId), exact: true })
      if (!query) {
        return
      }
      applyDuringModalRef.current ||= options.allowDuringModal === true
      // After any read in flight: it may predate the change this read is for.
      refetchHostQueryAfterInFlight(queryClient, query)
    },
    [hostId, queryClient]
  )

  const startWorktreeRefresh = useCallback(() => {
    if (!client || connState !== 'connected') {
      return
    }
    return startHostWorktreeRefresh({
      client,
      refreshWorktrees: () => void fetchWorktrees(),
      syncViewSettings: syncViewSettingsFromDesktop,
      sidebarFeed,
      appState: AppState
    })
  }, [client, connState, fetchWorktrees, syncViewSettingsFromDesktop, sidebarFeed])

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

  // A read stuck on a replaced client must not hold the list back: TanStack joins a read in flight.
  const readClientRef = useRef(client)
  useEffect(() => {
    const replaced = readClientRef.current !== null && readClientRef.current !== client
    readClientRef.current = client
    if (!replaced || !hostId) {
      return
    }
    const hostList = { queryKey: hostScopeKey(hostId), predicate: isHostListQuery }
    void queryClient
      .cancelQueries(hostList)
      .then(() => queryClient.refetchQueries({ ...hostList, type: 'active' }))
  }, [client, hostId, queryClient])

  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = useCallback(async () => {
    if (!hostId || connState !== 'connected') {
      return
    }
    setRefreshing(true)
    try {
      await queryClient.refetchQueries({
        queryKey: hostScopeKey(hostId),
        type: 'active',
        predicate: isHostListQuery
      })
    } finally {
      setRefreshing(false)
    }
  }, [connState, hostId, queryClient])

  return {
    fetchWorktrees,
    onRefresh,
    refreshing,
    // The other host-list reads follow the catalog's visibility.
    subscribed,
    // The first read after the list painted from memory; polls and pull-to-refresh show nothing here.
    revalidating: catalog.isRefetching && !catalog.isFetchedAfterMount,
    // When the shown rows were read, possibly at an earlier launch.
    readAt: catalog.data ? catalog.dataUpdatedAt : null
  }
}

export type HostWorktreeCatalog = ReturnType<typeof useHostWorktreeCatalog>
