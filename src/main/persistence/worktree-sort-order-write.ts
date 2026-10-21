import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'
import {
  planWorktreeSortOrderUpdates,
  type WorktreeSortOrderUpdate
} from '../../shared/worktree/sort-order-update'
import { resolveWorktreeMetaOwner } from './host-qualified-worktree-meta'

export type WorktreeSortOrderRequest = {
  orderedIds: readonly string[]
  /** Parallel to `orderedIds`: the copy each id names. Older clients send none. */
  hostIds?: readonly string[]
}

type SortOrderStore = {
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  getWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId
  ) => WorktreeMeta | undefined
  getRepos: () => readonly Repo[]
  setWorktreeMeta: (target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => unknown
}

/** The client's host for this id when a repo row of this store is stamped exactly that. */
function knownHost(
  store: SortOrderStore,
  worktreeId: string,
  hostId: ExecutionHostId
): ExecutionHostId | null {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return store
    .getRepos()
    .some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === hostId)
    ? hostId
    : null
}

/**
 * Saves an order onto the copies it names. An id the client did not qualify lands only when one
 * host owns it, so a same-id twin on another host keeps its own order.
 * @returns the updates actually written.
 */
export function writeWorktreeSortOrder(
  store: SortOrderStore,
  request: WorktreeSortOrderRequest,
  isBlocked: (worktreeId: string) => boolean,
  now: number
): WorktreeSortOrderUpdate[] {
  const hostIds =
    request.hostIds?.length === request.orderedIds.length ? request.hostIds : undefined
  const targets = new Map<string, HostWorktreeTarget | undefined>()
  request.orderedIds.forEach((worktreeId, index) => {
    if (targets.has(worktreeId)) {
      return
    }
    // Before any host-qualified read: that read migrates a legacy row the move must keep frozen.
    if (isBlocked(worktreeId)) {
      targets.set(worktreeId, undefined)
      return
    }
    if (!hostIds) {
      targets.set(worktreeId, resolveWorktreeMetaOwner(store, worktreeId))
      return
    }
    const named = parseExecutionHostId(hostIds[index])
    const hostId = named ? knownHost(store, worktreeId, named.id) : null
    if (hostId) {
      targets.set(worktreeId, hostWorktreeTarget({ id: worktreeId, hostId }))
      return
    }
    // The client's `local` may be a row this server stamped with its own id, so it keeps the
    // id-only rule (which refuses twins); any other host this store lacks is skipped.
    targets.set(
      worktreeId,
      named?.kind === 'local' ? resolveWorktreeMetaOwner(store, worktreeId) : undefined
    )
  })
  const metaFor = (worktreeId: string): WorktreeMeta | undefined => {
    const target = targets.get(worktreeId)
    return target && store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(worktreeId, target.hostId)
      : store.getWorktreeMeta(worktreeId)
  }
  return planWorktreeSortOrderUpdates(request.orderedIds, metaFor, now).filter((update) => {
    const target = targets.get(update.worktreeId)
    if (!target) {
      return false
    }
    store.setWorktreeMeta(target, { sortOrder: update.sortOrder })
    return true
  })
}
