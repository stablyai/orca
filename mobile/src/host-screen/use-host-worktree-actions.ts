import { useCallback } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../src/shared/sidebar-inputs-switch'
import type { useRouter } from 'expo-router'
import { floatingWorkspaceSessionPath } from '../session/floating-workspace'
import { holdSessionLeave } from '../session/session-leave-guard'
import { savePinnedIds } from '../storage/preferences'
import type { useForgetHostClient } from '../transport/host-client-hooks'
import { removeHostAndCloseClient } from '../transport/host-removal-lifecycle'
import { isPageHostRemovalUnavailable } from '../transport/page-host-removal-refusal'
import type { RpcClient } from '../transport/rpc-client'
import {
  rpcClientForExecutionHost,
  workspaceRouteExecutionHost
} from '../transport/execution-host-scoped-rpc-client'
import { serverUpdateNeededNotice } from '../host-route-notice'
import type { ConnectionState } from '../transport/types'
import { leaveHostRoute } from '../host-route-exit'
import { getWorktreeRowIdentity, isSameWorktreeRow } from '../worktree/worktree-host-row-identity'
import { noteLastVisitedWorktree } from '../worktree/last-visited-worktree-by-host'
import { isWorktreePinned, type Worktree } from '../worktree/workspace-list-sections'
import { worktreeActivate, worktreePinWrite, worktreeSleep } from './host-screen-operations'
import type { HostScreenState } from './use-host-screen-state'
import { useHostWorktreeDelete } from './use-host-worktree-delete'

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
    pinnedIds,
    setActionError,
    setConfirmRemoveHost,
    setLastKnownWorktrees,
    setOptimisticActiveWorktreeIdentity,
    setPinnedIds,
    serverWorkspaces,
    setNewWorktreeVisible,
    setServerNotice,
    setServerWorkspaces,
    setSleptIds,
    setWorktrees,
    worktrees
  } = state

  // Route server-workspace actions through the desktop to their owning server.
  const clientForRow = useCallback(
    (item: Worktree) => client && rpcClientForExecutionHost(client, hostCapabilities, item.hostId),
    [client, hostCapabilities]
  )

  // A removed host leaves unconditionally; this is the user's own leave, which a recording session holds first.
  const leaveHost = useCallback(() => {
    if (!holdSessionLeave()) {
      leaveHostRoute(router)
    }
  }, [router])

  const openNewWorktreeModal = useCallback(
    () => setNewWorktreeVisible(true),
    [setNewWorktreeVisible]
  )
  const closeNewWorktreeModal = useCallback(
    () => setNewWorktreeVisible(false),
    [setNewWorktreeVisible]
  )

  const updateLocalPins = useCallback(
    (worktreeId: string, pinned: boolean) => {
      // Switch point: a feed-built list keeps no pin cache of its own.
      if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
        return
      }
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

  const putWorktreeToSleep = useCallback(
    (item: Worktree) => {
      if (!client) {
        return
      }
      setSleptIds((prev) => new Set(prev).add(getWorktreeRowIdentity(item)))
      void worktreeSleep.request(client, { worktree: `id:${item.worktreeId}` }).catch(() => null)
    },
    [client, setSleptIds]
  )

  const worktreeDelete = useHostWorktreeDelete({ client, clientForRow, fetchWorktrees, state })

  const handleRemoveHost = useCallback(async () => {
    if (!hostId) {
      return
    }
    try {
      await removeHostAndCloseClient(hostId, forgetHostClient)
      leaveHostRoute(router)
    } catch (error) {
      if (isPageHostRemovalUnavailable(error)) {
        // Page removal is unsupported; do not offer a confirm or retry that cannot work.
        setActionError(error.message)
        return
      }
      // Reopen the confirm after removal failure; ConfirmModal closes on confirm.
      setConfirmRemoveHost(true)
      // React Native Web Alert is a no-op; show a dismissible action error while keeping the list, header and confirm usable.
      setActionError('Could not remove host. Please try again.')
    }
  }, [hostId, router, forgetHostClient, setActionError, setConfirmRemoveHost])

  // beforeNavigate runs unless the open session holds the leave, so a held tap leaves the target untouched.
  const navigateFromHostList = useCallback(
    (target: string, selectPane = false, beforeNavigate?: () => void) => {
      if (!embedded) {
        beforeNavigate?.()
        router.push(target)
        return
      }
      // In the page every replace remounts the open session, even a pane tap, so only a no-op is not a leave.
      const noop = !selectPane && pathname === (target.split('?')[0] ?? target)
      if (!noop && holdSessionLeave()) {
        return
      }
      beforeNavigate?.()
      if (noop) {
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
    (item: Worktree, paneKey?: string) => {
      const server = serverWorkspaces.hosts.find((host) => host.hostId === item.hostId)
      if (server?.relay === 'update-needed') {
        setServerNotice(serverUpdateNeededNotice(server.label))
        return
      }
      const routeHost = workspaceRouteExecutionHost(client, hostCapabilities, item.hostId)
      if (routeHost === null) {
        return
      }
      // Use an empty missing hostId: the shell refuses /h//session, whereas the string undefined would name an accepted host.
      const executionHost = routeHost ? `&executionHost=${encodeURIComponent(routeHost)}` : ''
      const pane = paneKey ? `&paneKey=${encodeURIComponent(paneKey)}` : ''
      const target = `/h/${encodeURIComponent(hostId ?? '')}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}${executionHost}${pane}`
      navigateFromHostList(target, Boolean(paneKey), () => {
        // Record this phone’s visit before navigation; a session opened in another page cannot publish its stored write back here.
        if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
          setOptimisticActiveWorktreeIdentity(getWorktreeRowIdentity(item))
        } else if (hostId) {
          noteLastVisitedWorktree({ hostId, worktreeId: item.worktreeId, executionHost: routeHost })
        }
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
      })
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
    // The floating sentinel has no worktree record to activate; tabs.list hydrates its host-owned tabs.
    navigateFromHostList(floatingWorkspaceSessionPath(hostId))
  }, [hostId, navigateFromHostList])

  return {
    ...worktreeDelete,
    handleRemoveHost,
    leaveHost,
    navigateFromHostList,
    openFloatingWorkspace,
    openNewWorktreeModal,
    closeNewWorktreeModal,
    openWorktreeSession,
    putWorktreeToSleep,
    togglePin
  }
}

export type HostWorktreeActions = ReturnType<typeof useHostWorktreeActions>
