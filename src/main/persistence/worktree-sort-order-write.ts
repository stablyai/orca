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
  /** Parallel host identities; omitted by older clients. */
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

/** Unqualified IDs require unique ownership; return only written updates so same-ID siblings keep their order. */
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
    // Host-qualified reads can migrate legacy metadata, so check frozen moves first.
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
    // Client-local may mean this server; use unique-owner fallback, while unknown remote hosts stay skipped.
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
