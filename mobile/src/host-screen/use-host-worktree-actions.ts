import { useCallback } from 'react'
import { Alert } from 'react-native'
import type { useRouter } from 'expo-router'
import { floatingWorkspaceSessionPath } from '../session/floating-workspace'
import { savePinnedIds } from '../storage/preferences'
import type { useForgetHostClient } from '../transport/client-context'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { setHostRouteNewWorktreeVisible } from '../host-route-action-state'
import { leaveHostRoute } from '../host-route-exit'
import { getWorktreeRowIdentity, removeWorktreeRow } from '../worktree/worktree-host-row-identity'
import { isWorktreePinned, type Worktree } from '../worktree/workspace-list-sections'
import type { HostScreenState } from './use-host-screen-state'

export function useHostWorktreeActions(args: {
  client: RpcClient | null
  connState: ConnectionState
  embedded: boolean
  fetchWorktrees: (options?: { allowDuringModal?: boolean }) => Promise<void>
  forgetHostClient: ReturnType<typeof useForgetHostClient>
  hostId: string | undefined
  pathname: string
  router: ReturnType<typeof useRouter>
  state: HostScreenState
}) {
  const {
    client,
    connState,
    embedded,
    fetchWorktrees,
    forgetHostClient,
    hostId,
    pathname,
    router,
    state
  } = args
  const {
    newWorktreeModalRef,
    newWorktreeModalVisibleRef,
    pinnedIds,
    setConfirmRemoveHost,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    setRouteActionState,
    setWorktrees,
    worktrees
  } = state

  const leaveHost = useCallback(() => {
    leaveHostRoute(router)
  }, [router])

  const openNewWorktreeModal = useCallback(() => {
    const modal = newWorktreeModalRef.current
    if (!modal) {
      return
    }
    newWorktreeModalVisibleRef.current = true
    modal.open()
  }, [])

  const setShowNewWorktreeVisible = useCallback((visible: boolean) => {
    setRouteActionState((current) => setHostRouteNewWorktreeVisible(current, visible))
  }, [])

  const updateLocalPins = useCallback(
    (worktreeId: string, pinned: boolean) => {
      setPinnedIds((prev) => {
        const next = new Set(prev)
        if (pinned) {
          next.add(worktreeId)
        } else {
          next.delete(worktreeId)
        }
        if (hostId) {
          void savePinnedIds(hostId, next)
        }
        return next
      })
    },
    [hostId]
  )

  const togglePin = useCallback(
    (worktreeId: string) => {
      const worktree = worktrees.find((w) => w.worktreeId === worktreeId)
      const currentlyPinned = worktree
        ? isWorktreePinned(worktree, pinnedIds)
        : pinnedIds.has(worktreeId)
      const newPinned = !currentlyPinned

      setWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )
      setLastKnownWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: newPinned } : w))
      )

      updateLocalPins(worktreeId, newPinned)

      if (client) {
        client
          .sendRequest('worktree.set', {
            worktree: `id:${worktreeId}`,
            isPinned: newPinned
          })
          .catch(() => {})
      }
    },
    [client, worktrees, pinnedIds, updateLocalPins]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      if (!client) {
        return
      }

      const removeFromList = (list: Worktree[]) => removeWorktreeRow(list, item)
      setWorktrees(removeFromList)
      setLastKnownWorktrees(removeFromList)

      try {
        const response = await client.sendRequest('worktree.rm', {
          worktree: `id:${item.worktreeId}`,
          force: true
        })
        if (!response.ok) {
          setWorktrees((prev) => [...prev, item])
          setLastKnownWorktrees((prev) => [...prev, item])
        }
        void fetchWorktrees()
      } catch {
        setWorktrees((prev) => [...prev, item])
        setLastKnownWorktrees((prev) => [...prev, item])
      }
    },
    [client, fetchWorktrees]
  )

  const handleRemoveHost = useCallback(async () => {
    if (!hostId) {
      return
    }
    try {
      await removeHostAndCloseClient(hostId, forgetHostClient)
      leaveHost()
    } catch {
      // Why: removal can fail while still paired; re-open confirm (ConfirmModal closes on confirm).
      setConfirmRemoveHost(true)
      Alert.alert('Could not remove host', 'Please try again.')
    }
  }, [hostId, leaveHost, forgetHostClient])

  const navigateFromHostList = useCallback(
    (target: string) => {
      if (!embedded) {
        router.push(target)
        return
      }
      if (pathname === (target.split('?')[0] ?? target)) {
        return
      }
      if (pathname === `/h/${hostId}`) {
        router.push(target)
        return
      }
      router.replace(target)
    },
    [embedded, hostId, pathname, router]
  )

  const openWorktreeSession = useCallback(
    (item: Worktree) => {
      setOptimisticActiveWorktreeIdentity(getWorktreeRowIdentity(item))
      if (client && connState === 'connected') {
        void client
          .sendRequest('worktree.activate', {
            worktree: `id:${item.worktreeId}`,
            notifyClients: false,
            navigation: 'caller'
          })
          .catch(() => null)
      }
      const target = `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}`
      navigateFromHostList(target)
    },
    [client, connState, hostId, navigateFromHostList]
  )

  const openFloatingWorkspace = useCallback(() => {
    // Why: no worktree.activate here — the floating sentinel has no worktree
    // record; session.tabs.list hydrates its host-owned tabs on open.
    navigateFromHostList(floatingWorkspaceSessionPath(hostId))
  }, [hostId, navigateFromHostList])

  return {
    handleDeleteWorktree,
    handleRemoveHost,
    leaveHost,
    navigateFromHostList,
    openFloatingWorkspace,
    openNewWorktreeModal,
    openWorktreeSession,
    setShowNewWorktreeVisible,
    togglePin
  }
}

export type HostWorktreeActions = ReturnType<typeof useHostWorktreeActions>
