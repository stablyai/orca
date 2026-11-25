import type { Worktree } from '../../../shared/worktree/types'
import { isValidResolvedWorktreeLineageEdge } from '../../../shared/worktree/lineage/resolved-worktree-lineage'
import { normalizeLocalBranchName } from '../../runtime/workspaces/catalog/runtime-worktree-selection'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import {
  listWorkerCreatedWorktrees,
  type WorkerCreatedWorktree
} from '../../runtime/orchestration/db/worker-dispatch/worker-created-worktrees'

/** A workspace a worker start created whose worker has been released. */
export type WorkspaceCleanupReleasedWorker = {
  /** The coordinator's branch, when the coordinator's workspace is in the same repo; work landed there is not lost. */
  coordinatorBranch: string | null
}

export type WorkspaceCleanupReleasedWorkerLookup = (
  worktree: Worktree,
  repoWorktrees: readonly Worktree[]
) => WorkspaceCleanupReleasedWorker | undefined

/** Reads the host's workers at most once per scan; a host that never ran orchestration has none. */
export function createWorkspaceCleanupReleasedWorkerLookup(
  store: RuntimeStore,
  getOrchestrationDb: (() => OrchestrationDb | null) | undefined
): WorkspaceCleanupReleasedWorkerLookup {
  let workerCreatedWorktrees: ReadonlyMap<string, WorkerCreatedWorktree> | undefined
  const parents = new WeakMap<readonly Worktree[], ReturnType<typeof indexParents>>()
  return (worktree, repoWorktrees) => {
    workerCreatedWorktrees ??= readWorkerCreatedWorktrees(getOrchestrationDb)
    return resolveReleasedWorker(
      worktree,
      () => {
        let index = parents.get(repoWorktrees)
        if (!index) {
          index = indexParents(repoWorktrees)
          parents.set(repoWorktrees, index)
        }
        return index
      },
      workerCreatedWorktrees,
      store
    )
  }
}

function indexParents(worktrees: readonly Worktree[]) {
  const index = new Map<string, { any: Worktree | null; hosts: Map<string, Worktree | null> }>()
  for (const row of worktrees) {
    const key = JSON.stringify([row.id, row.instanceId])
    const entry = index.get(key)
    if (entry) {
      entry.any = null
      const host = row.hostId ?? ''
      entry.hosts.set(host, entry.hosts.has(host) ? null : row)
    } else {
      index.set(key, { any: row, hosts: new Map([[row.hostId ?? '', row]]) })
    }
  }
  return index
}

function readWorkerCreatedWorktrees(
  getOrchestrationDb: (() => OrchestrationDb | null) | undefined
): ReadonlyMap<string, WorkerCreatedWorktree> {
  try {
    const db = getOrchestrationDb?.()
    return db ? listWorkerCreatedWorktrees(db) : new Map()
  } catch (error) {
    console.warn('Workspace cleanup could not read orchestration workers', error)
    return new Map()
  }
}

function resolveReleasedWorker(
  worktree: Worktree,
  parents: () => ReturnType<typeof indexParents>,
  workerCreatedWorktrees: ReadonlyMap<string, WorkerCreatedWorktree>,
  store: RuntimeStore
): WorkspaceCleanupReleasedWorker | undefined {
  const worker = workerCreatedWorktrees.get(worktree.id)
  // SQLite stamps whole seconds. A workspace made after the worker started reuses the path; it is not the worker's.
  if (
    !worker?.released ||
    worktree.createdAt === undefined ||
    worktree.createdAt >= worker.workerStartedAt + 1000
  ) {
    return undefined
  }
  const lineage = store.getWorktreeLineage?.(worktree.id)
  const entry = lineage
    ? parents().get(JSON.stringify([lineage.parentWorktreeId, lineage.parentWorktreeInstanceId]))
    : undefined
  const candidate = worktree.hostId
    ? entry?.hosts.has(worktree.hostId) && entry.hosts.has('')
      ? undefined
      : (entry?.hosts.get(worktree.hostId) ??
        (entry?.hosts.has(worktree.hostId) ? undefined : entry?.hosts.get('')))
    : entry?.any
  const coordinator =
    candidate && lineage && isValidResolvedWorktreeLineageEdge(worktree, candidate, lineage)
      ? candidate
      : undefined
  const coordinatorBranch = normalizeLocalBranchName(coordinator?.branch)
  return {
    coordinatorBranch:
      coordinatorBranch && coordinatorBranch !== normalizeLocalBranchName(worktree.branch)
        ? coordinatorBranch
        : null
  }
}
