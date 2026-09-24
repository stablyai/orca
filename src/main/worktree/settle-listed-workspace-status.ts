import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  settleWorkspaceStatus,
  shouldPersistSettledWorkspaceStatus,
  type LinkedReviewSettlementState,
  type LinkedTaskSettlementSignal
} from '../../shared/worktree/workspace-status-settlement'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { countUniqueCommitsAgainstDefaultBranch } from '../git/default-branch-unique-commit-count'
import { writeWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { Store } from '../persistence'
import { gitExecForWorkspaceStatus } from './workspace-status-git-exec'

const FINISHED_TASK_STATUSES = new Set(['completed', 'failed'])
const ACTIVE_TASK_STATUSES = new Set(['pending', 'ready', 'dispatched', 'blocked'])

type GithubPrCache = {
  pr?: Record<string, { data: { number: number; state: string } | null } | undefined>
}

type OrchestrationStatement = {
  all: (...params: string[]) => unknown
}

type SettlementStore = {
  getRepos: () => readonly Repo[]
  getGitHubCache?: () => GithubPrCache
  getAllWorktreeLineage?: () => Record<string, WorktreeLineage>
  getWorktreeMeta?: (worktreeId: string) => WorktreeMeta | undefined
  getAllWorktreeMeta?: () => Record<string, WorktreeMeta>
  setWorktreeMeta?: (worktreeId: string, meta: Partial<WorktreeMeta>) => WorktreeMeta
  setWorktreeMetaForHost?: (
    worktreeId: string,
    executionHostId: ExecutionHostId,
    meta: Partial<WorktreeMeta>
  ) => WorktreeMeta
}

const TASK_STATUS_SQL = `SELECT t.status AS status
  FROM tasks t
  WHERE t.id = ?
  UNION
  SELECT t.status AS status
  FROM worker_dispatches wd
  JOIN dispatch_contexts dc ON dc.id = wd.dispatch_id
  JOIN tasks t ON t.id = dc.task_id
  WHERE wd.worktree_id = ?`

function shortBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function reviewStateForWorktree(
  cache: GithubPrCache['pr'] | undefined,
  repo: Repo | undefined,
  worktree: Worktree
): LinkedReviewSettlementState | null {
  const linkedElsewhere = [
    worktree.linkedGitLabMR,
    worktree.linkedBitbucketPR,
    worktree.linkedAzureDevOpsPR,
    worktree.linkedGiteaPR
  ].some((number) => typeof number === 'number' && number > 0)
  if (!cache || !repo) {
    if (worktree.linkedPR != null || linkedElsewhere) {
      return 'unknown'
    }
    return null
  }
  const branch = shortBranch(worktree.branch)
  const cached = cache[`${repo.id}::${branch}`] ?? cache[`${repo.path}::${branch}`] ?? undefined
  const cachedState = cached?.data?.state
  const cachedNumber = cached?.data?.number
  const suppressed =
    worktree.linkedPR == null &&
    worktree.suppressedGitHubPR != null &&
    cachedNumber === worktree.suppressedGitHubPR
  if (!suppressed && isReviewState(cachedState)) {
    if (worktree.linkedPR == null || cachedNumber === worktree.linkedPR) {
      return cachedState
    }
  }
  if (worktree.linkedPR != null) {
    for (const [key, entry] of Object.entries(cache)) {
      if (!key.startsWith(`${repo.id}::`) && !key.startsWith(`${repo.path}::`)) {
        continue
      }
      if (entry?.data?.number === worktree.linkedPR && isReviewState(entry.data.state)) {
        return entry.data.state
      }
    }
    return 'unknown'
  }
  return linkedElsewhere ? 'unknown' : null
}

function isReviewState(state: string | undefined): state is LinkedReviewSettlementState {
  return (
    state === 'open' ||
    state === 'draft' ||
    state === 'merged' ||
    state === 'closed' ||
    state === 'unknown'
  )
}

function prepareTaskStatusQuery(db: unknown): OrchestrationStatement | null {
  if (!db || typeof db !== 'object' || !('db' in db)) {
    return null
  }
  const database = db.db
  if (!database || typeof database !== 'object' || !('prepare' in database)) {
    return null
  }
  const prepare = database.prepare
  if (typeof prepare !== 'function') {
    return null
  }
  const statement: unknown = prepare.call(database, TASK_STATUS_SQL)
  if (!statement || typeof statement !== 'object' || !('all' in statement)) {
    return null
  }
  const all = statement.all
  if (typeof all !== 'function') {
    return null
  }
  return {
    all: (...params) => all.apply(statement, params)
  }
}

function taskSignalForWorktree(
  db: unknown,
  worktreeId: string,
  lineageTaskId: string | undefined
): LinkedTaskSettlementSignal {
  const statement = prepareTaskStatusQuery(db)
  if (!statement) {
    return lineageTaskId ? 'unknown' : 'none'
  }
  let rows: unknown
  try {
    rows = statement.all(lineageTaskId ?? '', worktreeId)
  } catch {
    return 'unknown'
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return lineageTaskId ? 'unknown' : 'none'
  }
  const statuses = rows.flatMap((row) => {
    if (!row || typeof row !== 'object' || !('status' in row)) {
      return []
    }
    const status = (row as { status: unknown }).status
    return typeof status === 'string' ? [status] : []
  })
  if (statuses.length === 0) {
    return 'unknown'
  }
  if (statuses.some((status) => ACTIVE_TASK_STATUSES.has(status))) {
    return 'active'
  }
  if (statuses.every((status) => FINISHED_TASK_STATUSES.has(status))) {
    return 'finished'
  }
  return 'unknown'
}

function storedStatusFor(store: SettlementStore, worktree: Worktree): string | undefined {
  return (
    store.getWorktreeMeta?.(worktree.id)?.workspaceStatus ??
    store.getAllWorktreeMeta?.()[worktree.id]?.workspaceStatus
  )
}

/**
 * Publish workspace status for a listing.
 * Main checkouts leave the task machine. Non-main in-progress rows leave it when
 * HEAD is contained in the default branch, the linked review is merged or closed,
 * or every linked orchestration task is completed or failed.
 */
export async function settleListedWorkspaceStatuses<T extends Worktree>(args: {
  store: SettlementStore
  worktrees: readonly T[]
  orchestrationDb?: unknown
}): Promise<T[]> {
  if (args.worktrees.length === 0) {
    return [...args.worktrees]
  }
  const repos = args.store.getRepos()
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const lineage = args.store.getAllWorktreeLineage?.() ?? {}
  const cache = args.store.getGitHubCache?.().pr
  const headsByRepo = new Map<string, { id: string; head: string }[]>()
  for (const worktree of args.worktrees) {
    if (worktree.isMainWorktree) {
      continue
    }
    const stored = storedStatusFor(args.store, worktree)
    if (stored !== undefined && stored.length > 0 && stored !== 'in-progress') {
      continue
    }
    const repo = repoById.get(worktree.repoId)
    if (!repo || !worktree.head) {
      continue
    }
    const heads = headsByRepo.get(repo.id) ?? []
    heads.push({ id: worktree.id, head: worktree.head })
    headsByRepo.set(repo.id, heads)
  }
  const uniqueCommitsByWorktree = new Map<string, number>()
  await Promise.all(
    [...headsByRepo.entries()].map(async ([repoId, heads]) => {
      const repo = repoById.get(repoId)
      if (!repo) {
        return
      }
      const counts = await countUniqueCommitsAgainstDefaultBranch({
        repoKey: `${getRepoExecutionHostId(repo)}\0${repo.path}`,
        exec: gitExecForWorkspaceStatus(args.store as Store, repo),
        heads
      })
      for (const [id, count] of counts) {
        uniqueCommitsByWorktree.set(id, count)
      }
    })
  )
  const persistStore = args.store as Store
  return args.worktrees.map((worktree) => {
    const stored = storedStatusFor(args.store, worktree)
    const repo = repoById.get(worktree.repoId)
    const next = settleWorkspaceStatus({
      isMainWorktree: worktree.isMainWorktree,
      storedStatus: stored,
      uniqueCommitCount: uniqueCommitsByWorktree.get(worktree.id) ?? null,
      linkedReviewState: reviewStateForWorktree(cache, repo, worktree),
      linkedTaskSignal: taskSignalForWorktree(
        args.orchestrationDb ?? null,
        worktree.id,
        lineage[worktree.id]?.taskId
      )
    })
    if (
      shouldPersistSettledWorkspaceStatus({
        isMainWorktree: worktree.isMainWorktree,
        storedStatus: stored,
        nextStatus: next
      })
    ) {
      try {
        const hostId = worktree.hostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
        if (hostId && args.store.setWorktreeMeta) {
          writeWorktreeMetaForHost(persistStore, worktree.id, hostId, { workspaceStatus: next })
        }
      } catch {
        // The listing still publishes the settled status when the write fails.
      }
    }
    return worktree.workspaceStatus === next ? worktree : { ...worktree, workspaceStatus: next }
  })
}
