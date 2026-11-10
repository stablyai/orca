import { getRepoRegistrationHostIds } from '../../shared/repo-host-identity'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import { isLocalOnlyWorktreeMetaId } from '../../shared/worktree/local-only-worktree-meta-ids'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'

/** Partial listing stores may lack host accessors; real Stores always provide them. */
export type HostQualifiedWorktreeMetaStore = {
  getAllWorktreeMeta: () => Record<string, WorktreeMeta>
  getWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId
  ) => WorktreeMeta | undefined
  getAllWorktreeMetaForHost?: (executionHostId: ExecutionHostId) => Record<string, WorktreeMeta>
}

export function readAllWorktreeMetaForHost<
  TMeta extends { hostId?: ExecutionHostId } = WorktreeMeta
>(
  store: {
    getAllWorktreeMeta: () => Record<string, TMeta>
    getAllWorktreeMetaForHost?: (executionHostId: ExecutionHostId) => Record<string, TMeta>
  },
  executionHostId: ExecutionHostId
): Record<string, TMeta> {
  const qualified = store.getAllWorktreeMetaForHost?.(executionHostId)
  if (qualified) {
    return qualified
  }
  const projected: Record<string, TMeta> = {}
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (!meta.hostId || meta.hostId === executionHostId) {
      projected[worktreeId] = meta
    }
  }
  return projected
}

/** Never fall back to locator-only reads: same-id rows on other hosts may own that metadata. */
export function readWorktreeMetaForHost(
  store: Pick<HostQualifiedWorktreeMetaStore, 'getWorktreeMetaForHost'>,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeMeta | undefined {
  return store.getWorktreeMetaForHost?.(worktreeId, executionHostId)
}

export function readAllWorktreeMetaForRepo(
  store: Pick<HostQualifiedWorktreeMetaStore, 'getAllWorktreeMeta' | 'getAllWorktreeMetaForHost'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): Record<string, WorktreeMeta> {
  return readAllWorktreeMetaForHost(store, getRepoExecutionHostId(repo))
}

export function readWorktreeMetaForRepo(
  store: Pick<HostQualifiedWorktreeMetaStore, 'getWorktreeMetaForHost'>,
  worktreeId: string,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): WorktreeMeta | undefined {
  return readWorktreeMetaForHost(store, worktreeId, getRepoExecutionHostId(repo))
}

/** Resolve stamped or sole-repo ownership; ambiguous same-id hosts remain undefined. */
export function resolveWorktreeMetaOwner(
  store: {
    getWorktreeMeta: (worktreeId: string) => { hostId?: ExecutionHostId } | undefined
    getRepos: () => readonly Repo[]
  },
  worktreeId: string
): HostWorktreeTarget | undefined {
  // Local-only IDs have no backing repo from which to infer an owner.
  if (isLocalOnlyWorktreeMetaId(worktreeId)) {
    return hostWorktreeTarget({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID })
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const owners = store.getRepos().filter((repo) => repo.id === repoId)
  // The first writer stamp cannot disambiguate same-id repos on multiple hosts.
  if (getRepoRegistrationHostIds(owners, repoId).size > 1) {
    return undefined
  }
  const stamped = store.getWorktreeMeta(worktreeId)?.hostId
  if (stamped) {
    return hostWorktreeTarget({ id: worktreeId, hostId: stamped })
  }
  return owners[0] ? hostWorktreeTargetForRepo(worktreeId, owners[0]) : undefined
}

export function worktreeRowTarget(
  store: Parameters<typeof resolveWorktreeMetaOwner>[0],
  worktree: { id: string; hostId?: ExecutionHostId }
): HostWorktreeTarget | undefined {
  return worktree.hostId
    ? hostWorktreeTarget({ id: worktree.id, hostId: worktree.hostId })
    : resolveWorktreeMetaOwner(store, worktree.id)
}

/** Prefer explicit host, then saved stamp; only unstamped rows may be removed across all hosts. */
export function removeWorktreeMetaRow(
  store: {
    getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
    removeWorktreeMeta: (target: HostWorktreeTarget) => void
    removeUnhostedWorktreeMeta?: (worktreeId: string) => boolean
  },
  worktreeId: string,
  hostId: ExecutionHostId | undefined
): void {
  const owner = hostId ?? store.getWorktreeMeta(worktreeId)?.hostId
  if (owner) {
    store.removeWorktreeMeta(hostWorktreeTarget({ id: worktreeId, hostId: owner }))
  } else {
    store.removeUnhostedWorktreeMeta?.(worktreeId)
  }
}

export function hostWorktreeTargetForRepo(
  worktreeId: string,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): HostWorktreeTarget {
  return hostWorktreeTarget({ id: worktreeId, hostId: getRepoExecutionHostId(repo) })
}
