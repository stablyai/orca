import { useCallback, useEffect } from 'react'
import { useFocusEffect } from 'expo-router'
import { setCachedWorktrees } from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
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

export function useHostWorktreeCatalog(args: {
  client: RpcClient | null
  connState: ConnectionState
  embedded: boolean
  fetchRepoMetadata: FetchHostRepoMetadata
  hostId: string | undefined
  state: HostScreenState
  syncViewSettingsFromDesktop: () => Promise<void>
}) {
  const {
    client,
    connState,
    embedded,
    fetchRepoMetadata,
    hostId,
    state,
    syncViewSettingsFromDesktop
  } = args
  const {
    clientRef,
    fetchWorktreesInFlightRef,
    newWorktreeModalVisibleRef,
    setCatalogError,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    setSleptIds,
    setWorktrees,
    setWorktreesLoaded,
    worktreeCatalogRef
  } = state

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
      } catch {
        // Will retry on reconnect
        if (clientRef.current === requestClient && hostId === requestHostId) {
          setCatalogError('network_error')
        }
      } finally {
        fetchWorktreesInFlightRef.current = false
      }
    },
    [client, connState, hostId]
  )

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
    return startHostWorktreeRefresh({ client, fetchWorktrees, fetchRepoMetadata })
  }, [client, connState, fetchWorktrees, fetchRepoMetadata, syncViewSettingsFromDesktop])

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
