// A workspace's PR read outside its sidebar row (the agent work list): the shared PR cache that row
// reads. A stale entry is read again as background work on the shared PR refresh queue (budgeted,
// coalesced, rate-limit and cadence aware). Main applies the queue's refresh events to its cache as
// a window does, so readers see them with no window open.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { resolvePRBranchFallback } from '../../../../shared/github/pull-requests/refresh/pr-branch-fallback-rule'
import { getGitHubPRCacheKeyCandidates } from '../../../../shared/github/cache/github-cache-key'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  shownWorkspaceReviewPR,
  workspaceReviewPREntry
} from '../../../../shared/sidebar-list/feed-facts/workspace-review-facts'
import { getWorktreeGitHubPRUrl } from '../../../../shared/worktree/github-linked-item-url'
import type { Worktree } from '../../../../shared/worktree/types'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import { applyRegisteredRepoToPRRefreshCandidate } from '../../../ipc/source-control/github-repo-routing'
import type { ProjectRuntimeResolutionStore } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import {
  hasStaleHead,
  refreshIntervalForCandidate,
  validateCandidate
} from './pr-refresh-candidate-policy'
import { addPRRefreshEventListener, enqueuePRRefresh } from './pr-refresh-coordinator'

type PRCacheEntry = PersistedState['githubCache']['pr'][string] & {
  fetchedHeadOid?: string | null
}

export type WorkspacePRReadStore = ProjectRuntimeResolutionStore & {
  getGitHubCache: () => PersistedState['githubCache']
  setGitHubCache?: (cache: PersistedState['githubCache']) => void
  getRepos: () => readonly Repo[]
}

export type WorkspacePRReadWorktree = Pick<
  Worktree,
  'id' | 'branch' | 'head' | 'linkedPR' | 'suppressedGitHubPR' | 'linkedWorkItem' | 'linkedItems'
> &
  Partial<Pick<Worktree, 'isBare' | 'isArchived'>>

// Below a shown row's reads (40), so this never promotes or outruns the sidebar's own work.
const WORKSPACE_PR_READ_PRIORITY = 10

/** The read a row of this workspace would ask for, with the cached answer it would judge. */
export function workspacePRRefreshCandidate(
  store: WorkspacePRReadStore,
  worktree: WorkspacePRReadWorktree,
  repo: Repo,
  entry: PRCacheEntry | null
): GitHubPRRefreshCandidate | null {
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  // Another host's repo is read there (SSH waits for its row's connection; a runtime reads its own).
  if (!branch || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const cachedPR = entry?.data ?? null
  const linkedPRNumber = worktree.linkedPR ?? null
  const fallback = resolvePRBranchFallback({
    linkedPRNumber,
    cachedPR,
    hintPRNumber: null,
    currentHeadOid: worktree.head
  })
  const linkedPRUrl = getWorktreeGitHubPRUrl(worktree, linkedPRNumber)
  return applyRegisteredRepoToPRRefreshCandidate(store, repo, {
    cacheKey: getGitHubPRCacheKeyCandidates(repo, branch)[0],
    repoKind: repo.kind ?? 'git',
    repoId: repo.id,
    repoPath: repo.path,
    branch,
    worktreeId: worktree.id,
    isBare: worktree.isBare,
    isArchived: worktree.isArchived,
    currentHeadOid: worktree.head || null,
    linkedPRNumber,
    ...(linkedPRUrl ? { linkedPRUrl } : {}),
    ...fallback,
    cachedHeadOid: entry?.fetchedHeadOid ?? cachedPR?.headSha ?? null,
    cachedFetchedAt: entry?.fetchedAt ?? null,
    cachedHasPR: entry ? cachedPR !== null : null,
    cachedPRState: cachedPR?.state ?? null,
    cachedChecksStatus: cachedPR?.checksStatus ?? null
  })
}

/** Whether the queue should read this answer again: a final state never, nor a branch that had no
 *  PR at its recorded head while that head and its link stay the same; otherwise once the cadence's interval has passed. */
function needsRead(candidate: GitHubPRRefreshCandidate, now: number): boolean {
  if (candidate.cachedPRState === 'merged' || candidate.cachedPRState === 'closed') {
    return false
  }
  if (
    candidate.cachedHasPR === false &&
    candidate.linkedPRNumber == null &&
    candidate.cachedHeadOid != null &&
    !hasStaleHead(candidate)
  ) {
    return false
  }
  const interval = refreshIntervalForCandidate(candidate)
  if (!Number.isFinite(interval)) {
    return false
  }
  return candidate.cachedFetchedAt == null || now - candidate.cachedFetchedAt >= interval
}

/** A branch read that missed after the merge deleted the branch keeps the merged PR at the
 *  workspace's head, as the window's cache does. */
function keepsMergedPRForFallbackMiss(
  known: PRInfo | null | undefined,
  outcome: Exclude<PRRefreshOutcome, { kind: 'upstream-error' }>,
  alias: GitHubPRRefreshAlias
): boolean {
  const head = alias.currentHeadOid
  return (
    outcome.kind === 'no-pr' &&
    alias.linkedPRNumber == null &&
    known?.state === 'merged' &&
    !outcome.rejectedPRUrls?.includes(known.url) &&
    Boolean(head) &&
    (known.headSha === head || known.confirmedContainedHeadOid === head)
  )
}

// The store the refresh events write back to: the one this host's readers read.
let writeBackStore: WorkspacePRReadStore | null = null

/** Writes each completed read the windows are sent to main's cache too, as a window applies it, for
 *  a repo still registered; the store keeps a newer entry and the cache's bound. */
function writeBack(event: GitHubPRRefreshEvent): void {
  const store = writeBackStore
  const outcome = event.outcome
  if (!store?.setGitHubCache || !outcome || outcome.kind === 'upstream-error') {
    return
  }
  const repoIds = new Set(store.getRepos().map((repo) => repo.id))
  const cache = store.getGitHubCache()
  const entries: Record<string, PRCacheEntry> = {}
  for (const alias of event.aliases) {
    const known = cache.pr[alias.cacheKey]
    if (
      alias.repoId &&
      repoIds.has(alias.repoId) &&
      (!known || known.fetchedAt < outcome.fetchedAt) &&
      !keepsMergedPRForFallbackMiss(known?.data, outcome, alias)
    ) {
      entries[alias.cacheKey] = {
        data: outcome.kind === 'found' ? outcome.pr : null,
        fetchedAt: outcome.fetchedAt,
        fetchedHeadOid: alias.currentHeadOid ?? null
      }
    }
  }
  if (Object.keys(entries).length === 0) {
    return
  }
  store.setGitHubCache({ ...cache, pr: { ...cache.pr, ...entries } })
}

/** The PR the workspace's row shows, from the shared cache, never waiting on GitHub; a stale entry
 *  is queued for a background read whose outcome reaches this cache and every window. */
export function readWorkspacePR(
  store: WorkspacePRReadStore,
  worktree: WorkspacePRReadWorktree,
  repo: Repo
): PRInfo | null {
  if (!writeBackStore) {
    addPRRefreshEventListener(writeBack)
  }
  writeBackStore = store
  const entry = workspaceReviewPREntry(worktree, repo, store.getGitHubCache().pr)
  const cached = shownWorkspaceReviewPR(worktree, entry?.data)
  let candidate: GitHubPRRefreshCandidate | null
  try {
    candidate = workspacePRRefreshCandidate(store, worktree, repo, entry)
  } catch {
    // A project runtime awaiting repair can't read; the row shows the cached PR too.
    return cached
  }
  if (candidate && !validateCandidate(candidate) && needsRead(candidate, Date.now())) {
    enqueuePRRefresh(candidate, 'swr', WORKSPACE_PR_READ_PRIORITY)
  }
  return cached
}
