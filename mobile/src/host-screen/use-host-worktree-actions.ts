import { useCallback } from 'react'
import type { useRouter } from 'expo-router'
import { floatingWorkspaceSessionPath } from '../session/floating-workspace'
import { savePinnedIds } from '../storage/preferences'
import type { useForgetHostClient } from '../transport/client-context'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { isPageHostRemovalUnavailable } from '../transport/page-host-removal-refusal'
import type { RpcClient } from '../transport/rpc-client'
import {
  rpcClientForExecutionHost,
  workspaceRouteExecutionHost
} from '../transport/execution-host-scoped-rpc-client'
import { serverUpdateNeededNotice } from '../host-route-notice'
import type { ConnectionState } from '../transport/types'
import { setHostRouteNewWorktreeVisible } from '../host-route-action-state'
import { leaveHostRoute } from '../host-route-exit'
import {
  getWorktreeRowIdentity,
  isSameWorktreeRow,
  removeWorktreeRow
} from '../worktree/worktree-host-row-identity'
import { isWorktreePinned, type Worktree } from '../worktree/workspace-list-sections'
import { relayHostWorktreeSleep } from '../worktree/server-workspace-operations'
import {
  worktreeActivate,
  worktreePinWrite,
  worktreeRemove,
  worktreeSleep
} from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'

export function useHostWorktreeActions(args: {
  client: RpcClient | null
  connState: ConnectionState
  embedded: boolean
  fetchWorktrees: (options?: { allowDuringModal?: boolean }) => Promise<void>
  forgetHostClient: ReturnType<typeof useForgetHostClient>
  hostCapabilities: readonly string[]
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
    hostCapabilities,
    hostId,
    pathname,
    router,
    state
  } = args
  const {
    newWorktreeModalRef,
    newWorktreeModalVisibleRef,
    pinnedIds,
    setActionError,
    setConfirmRemoveHost,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    serverWorkspaces,
    setRouteActionState,
    setServerNotice,
    setServerWorkspaces,
    setSleptIds,
    setWorktrees,
    worktrees
  } = state

  // Why: a server's workspace is acted on where it runs, through the desktop.
  const clientForRow = useCallback(
    (item: Worktree) => client && rpcClientForExecutionHost(client, hostCapabilities, item.hostId),
    [client, hostCapabilities]
  )

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
    (item: Worktree) => {
      // Why: the desktop pins a server's workspace on that server (worktree.set at its owner).
      if (item.hostId?.startsWith('runtime:')) {
        const rowClient = clientForRow(item)
        if (!rowClient) {
          return
        }
        const isPinned = !item.isPinned
        setServerWorkspaces((prev) => ({
          ...prev,
          worktrees: prev.worktrees.map((w) =>
            isSameWorktreeRow(w, item) ? { ...w, isPinned } : w
          )
        }))
        void worktreePinWrite
          .request(rowClient, { worktree: `id:${item.worktreeId}`, isPinned })
          .catch(() => {})
        return
      }
      const { worktreeId } = item
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
        worktreePinWrite
          .request(client, {
            worktree: `id:${worktreeId}`,
            isPinned: newPinned
          })
          .catch(() => {})
      }
    },
    [client, clientForRow, worktrees, pinnedIds, updateLocalPins]
  )

  const sleepWorktree = useCallback(
    (item: Worktree) => {
      if (!client) {
        return
      }
      setSleptIds((prev) => new Set(prev).add(getWorktreeRowIdentity(item)))
      // Why: the desktop sleeps a server's workspace in its own renderer, as it does its own.
      const serverHost = item.hostId
      const sleep = serverHost?.startsWith('runtime:')
        ? relayHostWorktreeSleep.request(client, {
            hostId: serverHost,
            worktreeId: item.worktreeId
          })
        : worktreeSleep.request(client, { worktree: `id:${item.worktreeId}` })
      void sleep.catch(() => null)
    },
    [client, setSleptIds]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      const rowClient = clientForRow(item)
      if (!rowClient) {
        return
      }

      const removeFromList = (list: Worktree[]) => removeWorktreeRow(list, item)
      setWorktrees(removeFromList)
      setLastKnownWorktrees(removeFromList)

      try {
        const reply = await worktreeRemove.request(rowClient, {
          worktree: `id:${item.worktreeId}`,
          force: true
        })
        if (!worktreeRemove.interpret(reply).accepted) {
          setWorktrees((prev) => [...prev, item])
          setLastKnownWorktrees((prev) => [...prev, item])
        }
        void fetchWorktrees()
      } catch {
        setWorktrees((prev) => [...prev, item])
        setLastKnownWorktrees((prev) => [...prev, item])
      }
    },
    [clientForRow, fetchWorktrees]
  )

  const handleRemoveHost = useCallback(async () => {
    if (!hostId) {
      return
    }
    try {
      await removeHostAndCloseClient(hostId, forgetHostClient)
      leaveHost()
    } catch (error) {
      if (isPageHostRemovalUnavailable(error)) {
        // Neither the confirm nor "try again": on the page removal is refused, not failed, so
        // re-offering the control would be advice that cannot work anywhere in this document.
        setActionError(error.message)
        return
      }
      // Why: removal can fail while still paired; re-open confirm (ConfirmModal closes on confirm).
      setConfirmRemoveHost(true)
      // Not `Alert.alert`: it is a silent no-op in React Native Web, so inside the shell's page
      // this failure had no surface at all. And not the identity error either: that one is an
      // early return over the whole screen with nothing to dismiss it, so a removal that failed
      // once would cost the list, the header and the confirm this line is asking to re-open.
      setActionError('Could not remove host. Please try again.')
    }
  }, [hostId, leaveHost, forgetHostClient, setActionError, setConfirmRemoveHost])

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
      const server = serverWorkspaces.hosts.find((host) => host.hostId === item.hostId)
      if (server?.relay === 'update-needed') {
        setServerNotice(serverUpdateNeededNotice(server.label))
        return
      }
      const routeHost = workspaceRouteExecutionHost(client, hostCapabilities, item.hostId)
      if (routeHost === null) {
        return
      }
      setOptimisticActiveWorktreeIdentity(getWorktreeRowIdentity(item))
      const rowClient = clientForRow(item)
      if (rowClient && connState === 'connected') {
        void worktreeActivate
          .request(rowClient, {
            worktree: `id:${item.worktreeId}`,
            notifyClients: false,
            navigation: 'caller'
          })
          .catch(() => null)
      }
      // `?? ''` and not a cast: the hook takes `hostId` optional and every other member guards it,
      // so an absent one builds `/h//session/...` — a pathname the shell's segment rule refuses —
      // rather than the string "undefined", which it would accept as a host named undefined.
      const executionHost = routeHost ? `&executionHost=${encodeURIComponent(routeHost)}` : ''
      const target = `/h/${encodeURIComponent(hostId ?? '')}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}${executionHost}`
      navigateFromHostList(target)
    },
    [
      client,
      clientForRow,
      connState,
      hostCapabilities,
      hostId,
      navigateFromHostList,
      serverWorkspaces
    ]
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
    sleepWorktree,
    togglePin
  }
}

export type HostWorktreeActions = ReturnType<typeof useHostWorktreeActions>
