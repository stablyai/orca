import { useCallback } from 'react'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../src/shared/sidebar-list/feed/sidebar-inputs-switch'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { savePinnedIds } from '../../storage/preferences'
import { isSameWorktreeRow } from '../../worktree/row-presentation/worktree-host-row-identity'
import { isWorktreePinned } from '../../worktree/workspace-list/workspace-list-sections'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import { worktreePinWrite } from '../host-screen-operations'
import type { HostScreenState } from '../use-host-screen-state'

/** Pin state and writes for one host's rows: the desktop pins a server's workspace on that
 *  server, a local worktree's pin lands in local storage. Reads and writes go through the
 *  screen state so the sidebar's pin cache and the server's rows stay in one place. */
export function useHostWorktreePins(args: {
  client: RpcClient | null
  clientForRow: (item: Pick<Worktree, 'hostId'>) => RpcClient | null
  hostId: string | undefined
  state: HostScreenState
  worktrees: Worktree[]
}): {
  togglePin: (item: Worktree) => void
  updateLocalPins: (worktreeId: string, pinned: boolean) => void
} {
  const { client, clientForRow, hostId, state, worktrees } = args
  const { pinnedIds, setPinnedIds, setServerWorkspaces, setWorktrees, setLastKnownWorktrees } = state

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

  return { togglePin, updateLocalPins }
}
