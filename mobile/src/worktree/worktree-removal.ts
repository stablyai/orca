import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { Worktree } from './workspace-list-types'

// Why: matches the desktop worktree.rm budget — SSH teardown, archive hooks and
// large node_modules deletes routinely outrun the generic 30s mobile RPC timeout.
export const WORKTREE_REMOVE_TIMEOUT_MS = 60_000

// Why: a removed worktree stays hidden only until worktree.ps stops reporting it;
// the TTL keeps a half-removed workspace from being invisible forever.
export const WORKTREE_REMOVAL_TOMBSTONE_TTL_MS = 60_000

const WORKTREE_REMOVE_FAILURE_FALLBACK = 'The host could not delete this workspace.'

export type WorktreeListUpdate = (updater: (list: Worktree[]) => Worktree[]) => void

export type RemoveWorktreeArgs = {
  worktree: Worktree
  client: Pick<RpcClient, 'sendRequest'>
  /** Applies the same edit to every list mirroring the host snapshot. */
  updateWorktreeLists: WorktreeListUpdate
  refresh: () => void
  onFailure: (message: string) => void
  now?: () => number
}

export type WorktreeRemovalTracker = {
  /** Drops rows this client already deleted from a host snapshot taken before the delete landed. */
  reconcile: (snapshot: Worktree[], now?: number) => Worktree[]
  remove: (args: RemoveWorktreeArgs) => Promise<void>
}

/**
 * Tracks worktrees this client asked the host to delete. `worktree.ps` polls every
 * 3s, so a snapshot requested before the delete resolves still lists the worktree and
 * would otherwise resurrect the row the user just removed.
 */
export function createWorktreeRemovalTracker(): WorktreeRemovalTracker {
  const removedAtById = new Map<string, number>()

  function reconcile(snapshot: Worktree[], now = Date.now()): Worktree[] {
    if (removedAtById.size === 0) {
      return snapshot
    }
    const reported = new Set(snapshot.map((entry) => entry.worktreeId))
    // Deleting the current entry mid-iteration is safe for a Map.
    for (const [worktreeId, removedAt] of removedAtById) {
      if (!reported.has(worktreeId) || now - removedAt >= WORKTREE_REMOVAL_TOMBSTONE_TTL_MS) {
        removedAtById.delete(worktreeId)
      }
    }
    if (removedAtById.size === 0) {
      return snapshot
    }
    return snapshot.filter((entry) => !removedAtById.has(entry.worktreeId))
  }

  async function remove({
    worktree,
    client,
    updateWorktreeLists,
    refresh,
    onFailure,
    now = Date.now
  }: RemoveWorktreeArgs): Promise<void> {
    const { worktreeId } = worktree
    removedAtById.set(worktreeId, now())
    updateWorktreeLists((list) => list.filter((entry) => entry.worktreeId !== worktreeId))

    const restore = (message: string): void => {
      removedAtById.delete(worktreeId)
      updateWorktreeLists((list) =>
        list.some((entry) => entry.worktreeId === worktreeId) ? list : [...list, worktree]
      )
      onFailure(message)
    }

    try {
      const response = await client.sendRequest(
        'worktree.rm',
        { worktree: `id:${worktreeId}`, force: true },
        { timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS }
      )
      if (!response.ok) {
        restore(response.error.message || WORKTREE_REMOVE_FAILURE_FALLBACK)
      }
    } catch (error) {
      // Why: a timed-out or socket-dropped rm may still be running on the host, so
      // keep the row hidden and let the next snapshot (or the TTL) settle it.
      if (!isRpcDeliveryUnknown(error)) {
        restore(error instanceof Error ? error.message : WORKTREE_REMOVE_FAILURE_FALLBACK)
      }
    } finally {
      refresh()
    }
  }

  return { reconcile, remove }
}
