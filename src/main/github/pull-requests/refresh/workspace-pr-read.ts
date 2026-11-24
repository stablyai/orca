// A workspace's PR read outside its sidebar row (the agent work list): the shared PR cache that row
// reads. A stale entry is read again as background work on the shared PR refresh queue (budgeted,
// coalesced, rate-limit and cadence aware), and the outcome is written back to that cache here in
// main, so readers see it with no window open; an open window applies it as it does any read.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type {
  GitHubPRRefreshCandidate,
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
import { aliasFromCandidate, refreshIntervalForCandidate } from './pr-refresh-candidate-policy'
import { addPRRefreshOutcomeObserver, enqueuePRRefresh } from './pr-refresh-coordinator'

type PRCacheEntry = PersistedState['githubCache']['pr'][string] & {
  fetchedHeadOid?: string | null
}

export type WorkspacePRReadStore = ProjectRuntimeResolutionStore & {
  getGitHubCache: () => PersistedState['githubCache']
  setGitHubCache?: (cache: PersistedState['githubCache']) => void
}

export type WorkspacePRReadWorktree = Pick<
  Worktree,
  'id' | 'branch' | 'head' | 'linkedPR' | 'suppressedGitHubPR' | 'linkedWorkItem' | 'linkedItems'
>

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

/** Whether the queue should read this answer again: a final state never; otherwise once the
 *  cadence's interval has passed (none under Off). */
function needsRead(candidate: GitHubPRRefreshCandidate, now: number): boolean {
  if (candidate.cachedPRState === 'merged' || candidate.cachedPRState === 'closed') {
    return false
  }
  const interval = refreshIntervalForCandidate(candidate)
  if (!Number.isFinite(interval)) {
    return false
  }
  return candidate.cachedFetchedAt == null || now - candidate.cachedFetchedAt >= interval
}

// Cache keys this module queued a read for, with the store their outcome is written back to.
const queuedReads = new Map<string, WorkspacePRReadStore>()
let observing = false

function writeBack(
  store: WorkspacePRReadStore,
  cacheKey: string,
  outcome: Exclude<PRRefreshOutcome, { kind: 'upstream-error' }>,
  headOid: string | null
): void {
  const cache = store.getGitHubCache()
  const known = cache.pr[cacheKey]
  if (!store.setGitHubCache || (known && known.fetchedAt >= outcome.fetchedAt)) {
    return
  }
  const entry: PRCacheEntry = {
    data: outcome.kind === 'found' ? outcome.pr : null,
    fetchedAt: outcome.fetchedAt,
    fetchedHeadOid: headOid
  }
  store.setGitHubCache({ ...cache, pr: { ...cache.pr, [cacheKey]: entry } })
}

function observeQueuedReads(): void {
  if (observing) {
    return
  }
  observing = true
  addPRRefreshOutcomeObserver((candidate, outcome, aliases) => {
    // A failure keeps the key queued: the queue's backoff gates the next read, its success lands.
    if (outcome.kind === 'upstream-error') {
      return
    }
    for (const alias of aliases.length > 0 ? aliases : [aliasFromCandidate(candidate)]) {
      const store = queuedReads.get(alias.cacheKey)
      if (store) {
        queuedReads.delete(alias.cacheKey)
        writeBack(store, alias.cacheKey, outcome, alias.currentHeadOid ?? null)
      }
    }
  })
}

/** The PR the workspace's row shows, from the shared cache, never waiting on GitHub; a stale entry
 *  is queued for a background read whose outcome reaches this cache and every window. */
export function readWorkspacePR(
  store: WorkspacePRReadStore,
  worktree: WorkspacePRReadWorktree,
  repo: Repo
): PRInfo | null {
  const entry = workspaceReviewPREntry(worktree, repo, store.getGitHubCache().pr)
  const cached = shownWorkspaceReviewPR(worktree, entry?.data)
  let candidate: GitHubPRRefreshCandidate | null
  try {
    candidate = workspacePRRefreshCandidate(store, worktree, repo, entry)
  } catch {
    // A project runtime awaiting repair can't read; the row shows the cached PR too.
    return cached
  }
  if (candidate && needsRead(candidate, Date.now())) {
    observeQueuedReads()
    queuedReads.set(candidate.cacheKey, store)
    enqueuePRRefresh(candidate, 'swr', WORKSPACE_PR_READ_PRIORITY)
  }
  return cached
}
