import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import type { Worktree } from './workspace-list-types'

// Why: matches the desktop worktree.rm budget — SSH teardown, archive hooks and
// large node_modules deletes routinely outrun the generic 30s mobile RPC timeout.
export const WORKTREE_REMOVE_TIMEOUT_MS = 60_000

// Why: a timed-out or socket-dropped rm may still be running on the host. Hide the row
// this long past the failure, then let the host's own answer stand. Measured from the
// failure, not the request, or the delete timeout would consume the whole window.
export const WORKTREE_REMOVAL_AMBIGUOUS_GRACE_MS = 60_000

// Snapshots that cannot settle a removal: replayed caches, not a fresh worktree.ps read.
export const STALE_SNAPSHOT_GENERATION = 0

const WORKTREE_REMOVE_FAILURE_FALLBACK = 'The host could not delete this workspace.'

type PendingRemoval = {
  // Snapshot generation past which the host's answer is authoritative. Null while the rm
  // is in flight and for ambiguous outcomes, where no snapshot can settle the question.
  authoritativeAfter: number | null
  // Deadline for an ambiguous outcome; null when the outcome is known.
  revealAt: number | null
}

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
  /** Stamps a worktree.ps read so reconcile can tell pre-delete snapshots from post-delete ones. */
  beginSnapshot: () => number
  /** Drops rows this client already deleted from a snapshot that predates the delete. */
  reconcile: (snapshot: Worktree[], generation: number, now?: number) => Worktree[]
  remove: (args: RemoveWorktreeArgs) => Promise<void>
}

/**
 * Tracks worktrees this client asked the host to delete. `worktree.ps` polls every 3s and
 * the host keeps reporting a worktree until the removal finishes, so without this a poll
 * issued before the delete landed resurrects the row the user just removed.
 */
export function createWorktreeRemovalTracker(): WorktreeRemovalTracker {
  const pending = new Map<string, PendingRemoval>()
  const inFlight = new Map<string, Promise<void>>()
  let snapshotGeneration = STALE_SNAPSHOT_GENERATION

  function beginSnapshot(): number {
    snapshotGeneration += 1
    return snapshotGeneration
  }

  function reconcile(snapshot: Worktree[], generation: number, now = Date.now()): Worktree[] {
    if (pending.size === 0) {
      return snapshot
    }
    const fresh = generation !== STALE_SNAPSHOT_GENERATION
    const reported = new Set(snapshot.map((entry) => entry.worktreeId))
    // Deleting the current entry mid-iteration is safe for a Map.
    for (const [worktreeId, removal] of pending) {
      const settled =
        // Why: the screen caches the reconciled list, so a replayed cache is missing the row
        // it is being asked about — only a real read proves the host stopped reporting it.
        (fresh && !reported.has(worktreeId)) ||
        (removal.authoritativeAfter !== null && generation > removal.authoritativeAfter) ||
        (removal.revealAt !== null && now >= removal.revealAt)
      if (settled) {
        pending.delete(worktreeId)
      }
    }
    if (pending.size === 0) {
      return snapshot
    }
    return snapshot.filter((entry) => !pending.has(entry.worktreeId))
  }

  async function runRemoval({
    worktree,
    client,
    updateWorktreeLists,
    refresh,
    onFailure,
    now = Date.now
  }: RemoveWorktreeArgs): Promise<void> {
    const { worktreeId } = worktree
    pending.set(worktreeId, { authoritativeAfter: null, revealAt: null })
    updateWorktreeLists((list) => list.filter((entry) => entry.worktreeId !== worktreeId))

    const restore = (message: string): void => {
      pending.delete(worktreeId)
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
      if (response.ok) {
        // Why: worktree ids are path-derived and get reused, so stop hiding as soon as a
        // read issued after the delete answers — otherwise a workspace recreated at the
        // same path stays invisible.
        pending.set(worktreeId, { authoritativeAfter: snapshotGeneration, revealAt: null })
      } else {
        restore(response.error.message || WORKTREE_REMOVE_FAILURE_FALLBACK)
      }
    } catch (error) {
      if (isRpcDeliveryUnknown(error)) {
        pending.set(worktreeId, {
          authoritativeAfter: null,
          revealAt: now() + WORKTREE_REMOVAL_AMBIGUOUS_GRACE_MS
        })
      } else {
        restore(error instanceof Error ? error.message : WORKTREE_REMOVE_FAILURE_FALLBACK)
      }
    } finally {
      refresh()
    }
  }

  // Why: the confirm button can double-fire before the sheet unmounts. Two rm's for one
  // worktree let the loser's rollback undo the winner's delete, so share one attempt —
  // the same coalescing the runtime does host-side.
  function remove(args: RemoveWorktreeArgs): Promise<void> {
    const { worktreeId } = args.worktree
    const existing = inFlight.get(worktreeId)
    if (existing) {
      return existing
    }
    const attempt = runRemoval(args).finally(() => {
      inFlight.delete(worktreeId)
    })
    inFlight.set(worktreeId, attempt)
    return attempt
  }

  return { beginSnapshot, reconcile, remove }
}

// Why: the list screen unmounts on navigation and is reused across hostIds, so per-mount
// state would forget an in-flight delete — and leak one host's ids onto another's list,
// since worktree ids are only unique per host.
const trackersByHostId = new Map<string, WorktreeRemovalTracker>()

export function getWorktreeRemovalTracker(hostId: string): WorktreeRemovalTracker {
  const existing = trackersByHostId.get(hostId)
  if (existing) {
    return existing
  }
  const tracker = createWorktreeRemovalTracker()
  trackersByHostId.set(hostId, tracker)
  return tracker
}
