import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { resolveRemoteHeadBranchViaExec, type GitExec } from '../../shared/git-default-base-ref'
import { gitExecFileAsync } from '../git/runner'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { hostedReviewRepoScope, scopeGeneration } from './hosted-review-scope-generations'
import type { HostedReviewLocalGitOptions } from './hosted-review-git-options'

// Bound short-lived entries because worktree churn can mint unlimited repo/host keys.
const REPO_DEFAULT_BRANCH_CACHE_TTL_MS = 30_000
const REPO_DEFAULT_BRANCH_CACHE_MAX_ENTRIES = 512
const REPO_DEFAULT_BRANCH_RESOLUTION_BUDGET_MS = 15_000

type RepoDefaultBranchCacheEntry = {
  expiresAt: number
  branchName: string | null
}

const repoDefaultBranchCache = new Map<string, RepoDefaultBranchCacheEntry>()
const repoDefaultBranchInFlight = new Map<string, Promise<string | null>>()

function getRepoDefaultBranchCacheKey(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: HostedReviewLocalGitOptions = {}
): string {
  // Namespace by native/WSL/SSH host so identical paths in different clones cannot share answers.
  const runtimeKey = connectionId
    ? `ssh:${connectionId}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  const scope = hostedReviewRepoScope(repoPath, getRepoExecutionHostId({ connectionId }))
  return [runtimeKey, repoPath, scopeGeneration(scope)].join('\0')
}

function pruneRepoDefaultBranchCache(now: number): void {
  for (const [key, entry] of repoDefaultBranchCache) {
    if (entry.expiresAt <= now) {
      repoDefaultBranchCache.delete(key)
    }
  }
  while (repoDefaultBranchCache.size > REPO_DEFAULT_BRANCH_CACHE_MAX_ENTRIES) {
    const oldestKey = repoDefaultBranchCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    repoDefaultBranchCache.delete(oldestKey)
  }
}

function createRepoGitExec(
  repoPath: string,
  connectionId: string | null | undefined,
  localGitOptions: HostedReviewLocalGitOptions
): GitExec | null {
  if (connectionId) {
    // Why: the repoPath is remote, so a local run could answer for the wrong repo.
    return null
  }
  const resolutionDeadline = Date.now() + REPO_DEFAULT_BRANCH_RESOLUTION_BUDGET_MS
  // Share one deadline across five fallback refs to bound unhealthy native/WSL hosts.
  return (argv) => {
    const timeoutMs = resolutionDeadline - Date.now()
    if (timeoutMs <= 0) {
      return Promise.reject(new Error('Default branch resolution timed out.'))
    }
    return gitExecFileAsync(argv, {
      cwd: repoPath,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {}),
      timeout: timeoutMs
    })
  }
}

/** Resolve through the caller's Git transport; null skips the default-branch guard when unresolvable. */
export function getRepoDefaultBranchName(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: HostedReviewLocalGitOptions = {}
): Promise<string | null> {
  return resolveCachedBranchName(
    getRepoDefaultBranchCacheKey(repoPath, connectionId, localGitOptions),
    async () => {
      const exec = createRepoGitExec(repoPath, connectionId, localGitOptions)
      const baseRef = exec ? await resolveDefaultBaseRefViaExec(exec) : null
      // Same base-ref → branch-name normalization as git/repo.ts getRemoteFileUrl.
      return baseRef ? baseRef.replace(/^origin\//, '') : null
    }
  )
}

export function getRemoteHeadBranchName(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: HostedReviewLocalGitOptions = {}
): Promise<string | null> {
  return resolveCachedBranchName(
    [getRepoDefaultBranchCacheKey(repoPath, connectionId, localGitOptions), remoteName].join('\0'),
    async () => {
      const exec = createRepoGitExec(repoPath, connectionId, localGitOptions)
      return exec ? resolveRemoteHeadBranchViaExec(exec, remoteName) : null
    }
  )
}

async function resolveCachedBranchName(
  cacheKey: string,
  resolve: () => Promise<string | null>
): Promise<string | null> {
  const now = Date.now()
  const cached = repoDefaultBranchCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.branchName
  }
  const pending = repoDefaultBranchInFlight.get(cacheKey)
  if (pending) {
    return pending
  }

  // Coalesce cold-cache subprocess chains across concurrent refreshers.
  const resolution = (async (): Promise<string | null> => {
    let branchName: string | null = null
    try {
      branchName = await resolve()
    } catch {
      branchName = null
    }
    const completedAt = Date.now()
    // Cache null briefly too; failure and missing default are indistinguishable, but TTL bounds fail-open behavior.
    pruneRepoDefaultBranchCache(completedAt)
    repoDefaultBranchCache.set(cacheKey, {
      branchName,
      expiresAt: completedAt + REPO_DEFAULT_BRANCH_CACHE_TTL_MS
    })
    pruneRepoDefaultBranchCache(completedAt)
    return branchName
  })()
  repoDefaultBranchInFlight.set(cacheKey, resolution)
  try {
    return await resolution
  } finally {
    if (repoDefaultBranchInFlight.get(cacheKey) === resolution) {
      repoDefaultBranchInFlight.delete(cacheKey)
    }
  }
}

/** #9171: implicit default-branch matches never expose non-open reviews; explicit links are exempt. Resolve lazily only for candidate non-open results. */
export async function shouldHideNonOpenReviewOnDefaultBranch(input: {
  /** Provider-normalized review state; 'closed' / 'merged' / 'locked' count as non-open. */
  state: string
  reviewNumber: number | null
  linkedReviewNumber?: number | null
  branchName: string
  repoPath: string
  connectionId?: string | null
  localGitOptions?: HostedReviewLocalGitOptions
}): Promise<boolean> {
  // Why: GitLab 'locked' is non-open too — normally a seconds-long merge
  // transition, but a stuck-locked trunk MR would otherwise attach forever.
  if (input.state !== 'closed' && input.state !== 'merged' && input.state !== 'locked') {
    return false
  }
  if (
    typeof input.linkedReviewNumber === 'number' &&
    input.reviewNumber === input.linkedReviewNumber
  ) {
    return false
  }
  if (!input.branchName) {
    return false
  }
  const defaultBranchName = await getRepoDefaultBranchName(
    input.repoPath,
    input.connectionId,
    input.localGitOptions
  )
  return defaultBranchName !== null && input.branchName === defaultBranchName
}

export function __resetRepoDefaultBranchCacheForTests(): void {
  repoDefaultBranchCache.clear()
  repoDefaultBranchInFlight.clear()
}
