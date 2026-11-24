// A workspace's PR read outside its row: the PR cache its row reads, read again through the PR
// refresh queue when a shown row would read it again, so a workspace nobody is looking at still
// reads merged once merged, and its row and every other reader of the cache see that read too.
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
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
import { refreshIntervalForCandidate } from './pr-refresh-candidate-policy'
import { readPRRefreshOutcome } from './pr-refresh-coordinator'

type PRCacheEntry = PersistedState['githubCache']['pr'][string] & {
  fetchedHeadOid?: string | null
}

export type WorkspacePRReadStore = ProjectRuntimeResolutionStore & {
  getGitHubCache: () => PersistedState['githubCache']
}

export type WorkspacePRReadWorktree = Pick<
  Worktree,
  'id' | 'branch' | 'head' | 'linkedPR' | 'suppressedGitHubPR' | 'linkedWorkItem' | 'linkedItems'
>

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

/** Whether a shown row would read this answer again: older than its Default interval. A merged
 *  PR with final checks never is, so a finished workspace costs no reads. */
function isStale(candidate: GitHubPRRefreshCandidate, now: number): boolean {
  return (
    candidate.cachedFetchedAt == null ||
    now - candidate.cachedFetchedAt >= refreshIntervalForCandidate(candidate, 'default')
  )
}

/** The PR the workspace's row shows, read again first when its row would; past `waitMs` (or on a
 *  failed read) the cached one, while the read still lands in the cache for the next reader. */
export async function readWorkspacePR(
  store: WorkspacePRReadStore,
  worktree: WorkspacePRReadWorktree,
  repo: Repo,
  waitMs: number
): Promise<PRInfo | null> {
  const entry = workspaceReviewPREntry(worktree, repo, store.getGitHubCache().pr)
  const cached = shownWorkspaceReviewPR(worktree, entry?.data)
  let candidate: GitHubPRRefreshCandidate | null
  try {
    candidate = workspacePRRefreshCandidate(store, worktree, repo, entry)
  } catch {
    // A project runtime awaiting repair can't read; the row shows the cached PR too.
    return cached
  }
  if (!candidate || !isStale(candidate, Date.now())) {
    return cached
  }
  const outcome = await readPRRefreshOutcome(candidate, waitMs)
  if (!outcome || outcome.kind === 'upstream-error') {
    return cached
  }
  return outcome.kind === 'found' ? shownWorkspaceReviewPR(worktree, outcome.pr) : null
}
