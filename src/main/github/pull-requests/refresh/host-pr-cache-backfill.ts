import type { PRSnapshotReply } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { withOwnerRepos } from '../../../../shared/sidebar-list/feed-facts/workspace-rows'
import {
  hostPRCacheKey,
  recordHostPROutcome,
  type HostPRCacheStore,
  type HostPRReadRequest
} from './host-pr-cache-recording'

export type HostPROutcomeRecorder = (
  repo: Repo,
  branch: string,
  outcome: PRSnapshotReply,
  request?: HostPRReadRequest
) => void

export type HostPRCacheBackfillOptions = {
  /** Wait (bounded) so the caller's own read sees the answers; otherwise run behind the reply. */
  wait?: boolean
  signal?: AbortSignal
  worktreeIds?: readonly string[]
}

export type HostPRCache = {
  record: HostPROutcomeRecorder
  backfill(options?: HostPRCacheBackfillOptions): Promise<void>
}

/** The worktree fields the backfill reads; ResolvedWorktree rows satisfy it. */
export type HostPRBackfillWorktree = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'branch' | 'head' | 'linkedPR' | 'isMainWorktree'
>

type BackfillTarget = {
  key: string
  repo: Repo
  branch: string
  linkedPR: number
  head: string | null
}

// Matches the renderer's PR cache TTL: an entry or attempt younger than this is not re-read.
export const HOST_PR_BACKFILL_TTL_MS = 300_000
const HOST_PR_BACKFILL_MAX_PER_RUN = 16
const HOST_PR_BACKFILL_CONCURRENCY = 2
const HOST_PR_BACKFILL_WAIT_BUDGET_MS = 10_000
// Unawaited runs (worktree.ps) are throttled so a polling client adds no per-call work.
const HOST_PR_BACKFILL_UNAWAITED_MIN_GAP_MS = 30_000

export function createHostPRCache(deps: {
  store: HostPRCacheStore
  listWorktrees: () => Promise<{
    worktrees: readonly HostPRBackfillWorktree[]
    repos: readonly Repo[]
  }>
  readPR: (repo: Repo, branch: string, linkedPR: number, head: string | null) => Promise<unknown>
  now?: () => number
}): HostPRCache {
  const now = deps.now ?? Date.now
  const attemptedAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<void>>()
  let lastUnawaitedRunAt = -Infinity

  const selectTargets = async (
    worktreeIds: ReadonlySet<string> | null
  ): Promise<{ targets: BackfillTarget[]; pending: Promise<void>[] }> => {
    const { worktrees, repos } = await deps.listWorktrees()
    const cache = deps.store.getGitHubCache().pr
    const at = now()
    for (const [key, time] of attemptedAt) {
      if (at - time >= HOST_PR_BACKFILL_TTL_MS) {
        attemptedAt.delete(key)
      }
    }
    const targets: BackfillTarget[] = []
    const pending: Promise<void>[] = []
    const seen = new Set<string>()
    for (const { worktree, repo } of withOwnerRepos(worktrees, repos)) {
      if (targets.length >= HOST_PR_BACKFILL_MAX_PER_RUN) {
        break
      }
      if (!repo || worktree.isMainWorktree || worktree.linkedPR == null) {
        continue
      }
      if (worktreeIds && !worktreeIds.has(worktree.id)) {
        continue
      }
      const key = hostPRCacheKey(repo, worktree.branch)
      if (!key || seen.has(key)) {
        continue
      }
      seen.add(key)
      const running = inFlight.get(key)
      if (running) {
        pending.push(running)
        continue
      }
      const entry = cache[key]
      // A merged PR is final; a fresh entry or recent attempt is within the TTL.
      if (
        entry?.data?.state === 'merged' ||
        (entry && at - entry.fetchedAt < HOST_PR_BACKFILL_TTL_MS)
      ) {
        continue
      }
      if (attemptedAt.has(key)) {
        continue
      }
      targets.push({
        key,
        repo,
        branch: worktree.branch,
        linkedPR: worktree.linkedPR,
        head: worktree.head || null
      })
    }
    return { targets, pending }
  }

  const start = (targets: BackfillTarget[]): Promise<void> => {
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < targets.length) {
        const target = targets[next++]
        attemptedAt.set(target.key, now())
        // The read's reply is recorded through `record`; a failure just waits out the TTL.
        const read = deps
          .readPR(target.repo, target.branch, target.linkedPR, target.head)
          .then(
            () => undefined,
            () => undefined
          )
          .finally(() => inFlight.delete(target.key))
        inFlight.set(target.key, read)
        await read
      }
    }
    const workers = Math.min(HOST_PR_BACKFILL_CONCURRENCY, targets.length)
    return Promise.all(Array.from({ length: workers }, worker)).then(() => undefined)
  }

  return {
    record: (repo, branch, outcome, request) =>
      recordHostPROutcome(deps.store, repo, branch, outcome, request),
    async backfill(options = {}) {
      if (!options.wait) {
        if (now() - lastUnawaitedRunAt < HOST_PR_BACKFILL_UNAWAITED_MIN_GAP_MS) {
          return
        }
        lastUnawaitedRunAt = now()
      }
      const { targets, pending } = await selectTargets(
        options.worktreeIds ? new Set(options.worktreeIds) : null
      )
      const run = Promise.all([start(targets), ...pending]).then(() => undefined)
      if (options.wait) {
        await waitBounded(run, options.signal)
      }
    }
  }
}

function waitBounded(run: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, HOST_PR_BACKFILL_WAIT_BUDGET_MS)
    timer.unref?.()
    signal?.addEventListener('abort', done, { once: true })
    void run.then(done)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** orcad only: served PR reads and on-demand backfill fill the cache no renderer writes here. */
export function installHostPRCache(
  store: HostPRCacheStore,
  runtime: {
    hostPRCache: HostPRCache | null
    listHostPRCacheWorktrees(): Promise<{
      worktrees: readonly HostPRBackfillWorktree[]
      repos: readonly Repo[]
    }>
    getRepoPRForBranch(
      repoSelector: string,
      branch: string,
      linkedPRNumber?: number | null,
      fallbackPRNumber?: number | null,
      acceptMergedFallbackPR?: boolean,
      currentHeadOid?: string | null,
      reason?: 'visible'
    ): Promise<unknown>
  }
): void {
  runtime.hostPRCache = createHostPRCache({
    store,
    listWorktrees: () => runtime.listHostPRCacheWorktrees(),
    // Budgeted background reads share the coordinator's admission, pacing and rate-limit gates.
    readPR: (repo, branch, linkedPR, head) =>
      runtime.getRepoPRForBranch(repo.id, branch, linkedPR, null, false, head, 'visible')
  })
}
