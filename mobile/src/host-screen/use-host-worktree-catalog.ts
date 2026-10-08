import { useCallback, useEffect, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import { setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { RpcIncompatibleReplyError } from '../transport/rpc-incompatible-reply-error'
import { showPinnedWorktreesInGroupsRead } from '../transport/settings-read-operations'
import { useWorktreeResync } from '../transport/use-worktree-resync'
import { startHostWorktreeRefresh } from '../worktree/host-worktree-refresh'
import { areWorktreeListsEqual } from '../worktree/worktree-list-snapshot'
import {
  clearConfirmedActiveWorktreeIdentity,
  retainLiveSleptWorktreeIdentities
} from '../worktree/worktree-host-row-identity'
import { savePinnedIds } from '../storage/preferences'
import type { FetchHostRepoMetadata } from './use-host-repo-metadata'
import type { HostScreenState } from './use-host-screen-state'
import { relaysToServers } from '../transport/execution-host-scoped-rpc-client'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import {
  applyServerWorkspaces,
  fetchServerWorkspaces,
  NO_SERVER_WORKSPACES
} from '../worktree/server-workspaces'

function isServerHost(host: ExecutionHostId | undefined): boolean {
  return host?.startsWith('runtime:') === true
}

export function useHostWorktreeCatalog(args: {
  client: RpcClient | null
  connState: ConnectionState
  embedded: boolean
  fetchRepoMetadata: FetchHostRepoMetadata
  hostCapabilities: readonly string[]
  hostId: string | undefined
  state: HostScreenState
  syncViewSettingsFromDesktop: () => Promise<void>
}) {
  const {
    client,
    connState,
    embedded,
    fetchRepoMetadata,
    hostCapabilities,
    hostId,
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
    setShowPinnedInGroups,
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
          const read = new Set<ExecutionHostId>(
            fetched.hosts.filter((_host, index) => fetched.rows[index]).map((host) => host.hostId)
          )
          setSleptIds((prev) =>
            retainLiveSleptWorktreeIdentities(
              prev,
              fetched.rows.flatMap((rows) => rows ?? []),
              (host) => host !== undefined && read.has(host)
            )
          )
        }
      } catch {
        // Keeps the rows shown; the next poll retries.
      } finally {
        if (serverFetchInFlightRef.current === requestClient) {
          serverFetchInFlightRef.current = null
        }
      }
    },
    [hostCapabilities, setSleptIds]
  )

  const fetchWorktrees = useCallback(
    async (options: { allowDuringModal?: boolean } = {}) => {
      if (!client || connState !== 'connected' || !hostId) {
        return
      }
      if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
        return
      }
      // Why: prevent slow remote hosts from stacking overlapping worktree.ps requests during polling.
      if (fetchWorktreesInFlightRef.current) {
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
          setSleptIds((prev) =>
            retainLiveSleptWorktreeIdentities(prev, confirmed, (host) => !isServerHost(host))
          )

          // Sync pin state from server so desktop-initiated pins reflect without relying on stale AsyncStorage.
          const serverPinned = new Set(confirmed.filter((w) => w.isPinned).map((w) => w.worktreeId))
          setPinnedIds((prev) => {
            if (serverPinned.size === prev.size && [...serverPinned].every((id) => prev.has(id))) {
              return prev
            }
            if (hostId) {
              void savePinnedIds(hostId, serverPinned)
            }
            return serverPinned
          })
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
      }
    },
    [client, connState, hostId, fetchServerRows]
  )

  useFocusEffect(
    useCallback(() => {
      // Why: focus nudges reconnect and probes a possibly half-open socket; empty deps fire per focus, not per state flip (which defeats backoff).
      // 'focus' keeps a healthy relay green — probe, never suspend (S2 grey blink).
      clientRef.current?.notifyForeground('focus')
    }, [])
  )

  const syncShowPinnedInGroups = useCallback(async (requestClient: RpcClient) => {
    try {
      const reply = await showPinnedWorktreesInGroupsRead.request(requestClient)
      if (clientRef.current !== requestClient) {
        return
      }
      const read = showPinnedWorktreesInGroupsRead.interpret(reply)
      if (read.accepted) {
        setShowPinnedInGroups(read.value)
      }
    } catch {
      // Best-effort: keep the current placement until the next focus/connect.
    }
  }, [])

  const startWorktreeRefresh = useCallback(() => {
    if (!client || connState !== 'connected') {
      return
    }
    void syncViewSettingsFromDesktop()
    void syncShowPinnedInGroups(client)
    return startHostWorktreeRefresh({ client, fetchWorktrees, fetchRepoMetadata })
  }, [
    client,
    connState,
    fetchWorktrees,
    fetchRepoMetadata,
    syncViewSettingsFromDesktop,
    syncShowPinnedInGroups
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
