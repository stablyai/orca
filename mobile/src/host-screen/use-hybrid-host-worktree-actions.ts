import { useCallback } from 'react'
import { Alert } from 'react-native'
import { floatingWorkspaceSessionPath } from '../session/floating-workspace'
import { setHostRouteNewWorktreeVisible } from '../host-route-action-state'
import { getWorktreeRowIdentity, removeWorktreeRow } from '../worktree/worktree-host-row-identity'
import { isWorktreePinned, type Worktree } from '../worktree/workspace-list-sections'
import type { HostWorkspaceOperations } from '../worktree/host-workspace-operations'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'
import type { HostScreenShellOperations } from '../worktree/host-screen-shell-operations'
import type { HostScreenHostState } from '../worktree/host-screen-host-state'
import type { HybridHostScreenState } from './use-hybrid-host-screen-state'

export function useHybridHostWorktreeActions(args: {
  operations: HostWorkspaceOperations | null
  connState: string
  embedded: boolean
  fetchWorktrees: (options?: { allowDuringModal?: boolean }) => Promise<void>
  hostId: string | undefined
  hostState: HostScreenHostState
  shellOperations: HostScreenShellOperations
  state: HybridHostScreenState
  workspaceCreationOperations: HostWorkspaceCreationOperations | null
}) {
  const { operations, connState, fetchWorktrees, hostId, hostState, shellOperations, state } = args
  const navigateFromHostList = shellOperations.navigateFromHostList
  const openNewWorktreeModal = useCallback(() => {
    state.newWorktreeModalVisibleRef.current = true
    state.newWorktreeModalRef.current?.open()
  }, [])
  const setShowNewWorktreeVisible = useCallback(
    (visible: boolean) =>
      state.setRouteActionState((current) => setHostRouteNewWorktreeVisible(current, visible)),
    []
  )
  const updateLocalPins = useCallback(
    (worktreeId: string, pinned: boolean) => {
      state.setPinnedIds((prev) => {
        const next = new Set(prev)
        if (pinned) {
          next.add(worktreeId)
        } else {
          next.delete(worktreeId)
        }
        if (hostId) {
          void hostState.savePinnedWorkspaceIds(hostId, next)
        }
        return next
      })
    },
    [hostId, hostState]
  )
  const togglePin = useCallback(
    (worktreeId: string) => {
      const worktree = state.worktrees.find((w) => w.worktreeId === worktreeId)
      const newPinned = !(worktree
        ? isWorktreePinned(worktree, state.pinnedIds)
        : state.pinnedIds.has(worktreeId))
      state.setWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )
      state.setLastKnownWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )
      updateLocalPins(worktreeId, newPinned)
      if (operations) {
        void operations.setPinned(worktreeId, newPinned).catch(() => {})
      }
    },
    [operations, state.worktrees, state.pinnedIds, updateLocalPins]
  )
  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      if (!operations) {
        return
      }
      const remove = (list: Worktree[]) => removeWorktreeRow(list, item)
      state.setWorktrees(remove)
      state.setLastKnownWorktrees(remove)
      try {
        const removed = await operations.removeWorkspace(item.worktreeId)
        if (!removed) {
          state.setWorktrees((p) => [...p, item])
          state.setLastKnownWorktrees((p) => [...p, item])
        }
        void fetchWorktrees()
      } catch {
        state.setWorktrees((p) => [...p, item])
        state.setLastKnownWorktrees((p) => [...p, item])
      }
    },
    [operations, fetchWorktrees]
  )
  const handleRemoveHost = useCallback(async () => {
    if (!hostId) {
      return
    }
    try {
      await shellOperations.removeHost()
      shellOperations.leaveHost()
    } catch {
      state.setConfirmRemoveHost(true)
      Alert.alert('Could not remove host', 'Please try again.')
    }
  }, [hostId, shellOperations])
  const openWorktreeSession = useCallback(
    (item: Worktree) => {
      state.setOptimisticActiveWorktreeIdentity(getWorktreeRowIdentity(item))
      if (operations && connState === 'connected') {
        void operations.activateWorkspace(item.worktreeId).catch(() => null)
      }
      navigateFromHostList(
        `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}`
      )
    },
    [operations, connState, hostId, navigateFromHostList]
  )
  const openFloatingWorkspace = useCallback(
    () => navigateFromHostList(floatingWorkspaceSessionPath(hostId)),
    [hostId, navigateFromHostList]
  )
  const sleepWorktree = useCallback(
    (worktreeId: string) =>
      operations ? operations.sleepWorkspace(worktreeId) : Promise.resolve(),
    [operations]
  )
  return {
    handleDeleteWorktree,
    handleRemoveHost,
    navigateFromHostList,
    openFloatingWorkspace,
    openNewWorktreeModal,
    openWorktreeSession,
    setShowNewWorktreeVisible,
    sleepWorktree,
    togglePin,
    leaveHost: shellOperations.leaveHost
  }
}
