import type { Worktree } from '../../../shared/worktree/types'
import { isValidResolvedWorktreeLineageEdge } from '../../../shared/resolved-worktree-lineage'
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
  return (worktree, repoWorktrees) => {
    workerCreatedWorktrees ??= readWorkerCreatedWorktrees(getOrchestrationDb)
    return resolveReleasedWorker(worktree, repoWorktrees, workerCreatedWorktrees, store)
  }
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
  repoWorktrees: readonly Worktree[],
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
  const coordinator = lineage
    ? repoWorktrees.find((candidate) =>
        isValidResolvedWorktreeLineageEdge(worktree, candidate, lineage)
      )
    : undefined
  const coordinatorBranch = normalizeLocalBranchName(coordinator?.branch)
  return {
    coordinatorBranch:
      coordinatorBranch && coordinatorBranch !== normalizeLocalBranchName(worktree.branch)
        ? coordinatorBranch
        : null
  }
}
