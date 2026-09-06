import { useCallback, useEffect } from 'react'
import { useFocusEffect } from 'expo-router'
import { useWorktreeResync } from '../transport/use-worktree-resync'
import type { ConnectionState } from '../transport/types'
import { startHostWorktreeRefresh } from '../worktree/host-worktree-refresh'
import { areWorktreeListsEqual } from '../worktree/worktree-list-snapshot'
import {
  clearConfirmedActiveWorktreeIdentity,
  retainLiveSleptWorktreeIdentities
} from '../worktree/worktree-host-row-identity'
import type {
  HostWorkspaceCatalogFetch,
  HostWorkspaceOperations
} from '../worktree/host-workspace-operations'
import { WORKTREE_PS_FULL_LIMIT } from '../worktree/worktree-catalog-snapshot-client'
import type { HostScreenHostState } from '../worktree/host-screen-host-state'
import type { HybridHostScreenState } from './use-hybrid-host-screen-state'

// Why: bindings without a snapshot token still poll; wrap their full list in the same shape so
// the hook has one apply path rather than two divergent ones.
async function fetchHostWorkspaceCatalog(
  operations: HostWorkspaceOperations,
  hostId: string | undefined
): Promise<HostWorkspaceCatalogFetch> {
  if (operations.fetchWorkspaceCatalog && hostId) {
    return operations.fetchWorkspaceCatalog(hostId)
  }
  const worktrees = await operations.listWorkspaces(WORKTREE_PS_FULL_LIMIT)
  return { kind: 'response', invalidShape: false, commit: () => worktrees }
}

export function useHybridHostScreenCatalog(args: {
  operations: HostWorkspaceOperations | null
  connState: ConnectionState
  embedded: boolean
  fetchRepoMetadata: (options?: { force?: boolean; queueIfInFlight?: boolean }) => Promise<void>
  hostId: string | undefined
  hostState: HostScreenHostState
  state: HybridHostScreenState
  syncViewSettingsFromDesktop: () => Promise<void>
}) {
  const {
    operations,
    connState,
    embedded,
    fetchRepoMetadata,
    hostId,
    hostState,
    state,
    syncViewSettingsFromDesktop
  } = args
  const {
    catalogWarmupSpentRef,
    fetchWorktreesInFlightRef,
    newWorktreeModalVisibleRef,
    setCatalogError,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    setSleptIds,
    setWorktrees,
    setWorktreesLoaded
  } = state
  const fetchWorktrees = useCallback(
    async (options: { allowDuringModal?: boolean } = {}) => {
      if (!operations || connState !== 'connected') {
        return
      }
      if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
        return
      }
      if (fetchWorktreesInFlightRef.current) {
        return
      }
      fetchWorktreesInFlightRef.current = true
      const request = operations,
        requestHostId = hostId
      // Why: `connected` on a relayed transport is the shell's snapshot, not proof its socket
      // serves yet; forgive the binding's first failure so the list keeps loading and retries.
      const warmupForgiven =
        request.connectionStateIsRelayed === true && !catalogWarmupSpentRef.current.has(request)
      catalogWarmupSpentRef.current.add(request)
      try {
        const fetched = await fetchHostWorkspaceCatalog(request, requestHostId)
        if (state.workspaceOperationsRef.current !== request || hostId !== requestHostId) {
          return
        }
        if (!options.allowDuringModal && newWorktreeModalVisibleRef.current) {
          return
        }
        // Why (STA-3123): a failed catalog request must not pass for "0 worktrees"; surface the
        // host's code so a broken remote host is diagnosable instead of looking empty.
        if (fetched.kind === 'request_failed') {
          if (!warmupForgiven) {
            setCatalogError(fetched.code)
          }
          return
        }
        if (fetched.invalidShape) {
          setCatalogError('invalid_response')
        }
        const next = fetched.commit()
        if (!next) {
          return
        }
        setCatalogError(null)
        setWorktrees((current) => (areWorktreeListsEqual(current, next) ? current : next))
        setLastKnownWorktrees((current) => (areWorktreeListsEqual(current, next) ? current : next))
        setWorktreesLoaded(true)
        if (hostId) {
          hostState.cacheWorkspaces(hostId, next)
        }
        setOptimisticActiveWorktreeIdentity((pending) =>
          clearConfirmedActiveWorktreeIdentity(pending, next)
        )
        setSleptIds((prev) => retainLiveSleptWorktreeIdentities(prev, next))
        const serverPinned = new Set(next.filter((w) => w.isPinned).map((w) => w.worktreeId))
        setPinnedIds((prev) => {
          if (serverPinned.size === prev.size && [...serverPinned].every((id) => prev.has(id))) {
            return prev
          }
          if (hostId) {
            void hostState.savePinnedWorkspaceIds(hostId, serverPinned)
          }
          return serverPinned
        })
      } catch {
        if (
          !warmupForgiven &&
          state.workspaceOperationsRef.current === request &&
          hostId === requestHostId
        ) {
          setCatalogError('network_error')
        }
      } finally {
        fetchWorktreesInFlightRef.current = false
      }
    },
    [operations, connState, hostId, hostState]
  )
  useFocusEffect(
    useCallback(() => {
      state.workspaceOperationsRef.current?.notifyForeground()
    }, [])
  )
  const startWorktreeRefresh = useCallback(() => {
    if (!operations || connState !== 'connected') {
      return
    }
    void syncViewSettingsFromDesktop()
    return startHostWorktreeRefresh({ operations, fetchWorktrees, fetchRepoMetadata })
  }, [operations, connState, fetchWorktrees, fetchRepoMetadata, syncViewSettingsFromDesktop])
  useFocusEffect(
    useCallback(
      () => (embedded ? undefined : startWorktreeRefresh()),
      [embedded, startWorktreeRefresh]
    )
  )
  useEffect(() => (embedded ? startWorktreeRefresh() : undefined), [embedded, startWorktreeRefresh])
  const { refreshing, onRefresh } = useWorktreeResync({
    available: operations !== null,
    connState,
    fetchWorktrees,
    fetchRepoMetadata
  })
  return { fetchWorktrees, onRefresh, refreshing }
}
