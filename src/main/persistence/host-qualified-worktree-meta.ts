import { getRepoRegistrationHostIds } from '../../shared/repo-host-identity'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../shared/worktree/host-qualified-identity'

/**
 * The listing paths take partial store shapes (`Pick<Store, ...>`), so the
 * host-qualified accessors are optional here and fall back to the locator-keyed
 * ones. A real Store always has them.
 */
export type HostQualifiedWorktreeMetaStore = {
  getAllWorktreeMeta: () => Record<string, WorktreeMeta>
  getWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId
  ) => WorktreeMeta | undefined
  getAllWorktreeMetaForHost?: (executionHostId: ExecutionHostId) => Record<string, WorktreeMeta>
}

/** Canonical host snapshot, with a filtered legacy fallback for partial test/compatibility stores. */
export function readAllWorktreeMetaForHost(
  store: Pick<HostQualifiedWorktreeMetaStore, 'getAllWorktreeMeta' | 'getAllWorktreeMetaForHost'>,
  executionHostId: ExecutionHostId
): Record<string, WorktreeMeta> {
  const qualified = store.getAllWorktreeMetaForHost?.(executionHostId)
  if (qualified) {
    return qualified
  }
  const projected: Record<string, WorktreeMeta> = {}
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (!meta.hostId || meta.hostId === executionHostId) {
      projected[worktreeId] = meta
    }
  }
  return projected
}

/**
 * The row this host owns at `worktreeId`, or undefined. Deliberately does NOT fall back to the
 * locator-keyed read: that would hand one host's metadata to another's row, which is the collision
 * every caller here is trying to avoid. Callers keep their own same-id ownership guard as fallback.
 */
export function readWorktreeMetaForHost(
  store: Pick<HostQualifiedWorktreeMetaStore, 'getWorktreeMetaForHost'>,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeMeta | undefined {
  return store.getWorktreeMetaForHost?.(worktreeId, executionHostId)
}

/**
 * The same two reads keyed off a repo row, so the resolve-then-read pair lives in one place. Four
 * call sites had open-coded it identically, which is the shape that lets one copy drift from the
 * rest (F7/F8).
 */
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

/**
 * The row an id-only caller (an agent hook, a sort list) means: the id's own host stamp, else its
 * repo's only host. Undefined when same-id twins leave it ambiguous: callers skip, never guess.
 */
export function resolveWorktreeMetaOwner(
  store: {
    getWorktreeMeta: (worktreeId: string) => { hostId?: ExecutionHostId } | undefined
    getRepos: () => readonly Repo[]
  },
  worktreeId: string
): HostWorktreeTarget | undefined {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const owners = store.getRepos().filter((repo) => repo.id === repoId)
  // Why: the raw-id row's stamp names whichever twin wrote first, not the twin the caller means.
  if (getRepoRegistrationHostIds(owners, repoId).size > 1) {
    return undefined
  }
  const stamped = store.getWorktreeMeta(worktreeId)?.hostId
  if (stamped) {
    return hostWorktreeTarget({ id: worktreeId, hostId: stamped })
  }
  return owners[0] ? hostWorktreeTargetForRepo(worktreeId, owners[0]) : undefined
}

/** A worktree row's own host when it carries one; otherwise as `resolveWorktreeMetaOwner`. */
export function worktreeRowTarget(
  store: Parameters<typeof resolveWorktreeMetaOwner>[0],
  worktree: { id: string; hostId?: ExecutionHostId }
): HostWorktreeTarget | undefined {
  return worktree.hostId
    ? hostWorktreeTarget({ id: worktree.id, hostId: worktree.hostId })
    : resolveWorktreeMetaOwner(store, worktree.id)
}

/** Removes by the caller's host, else the row's own stamp; only an unstamped row goes on every host. */
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
