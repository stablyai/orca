import { resolveDefaultBaseRefViaExec } from '../git/repo'
import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { HostedReviewLocalGitOptions } from './hosted-review-git-options'

// Why: bounded like TRACKED_UPSTREAM_SNAPSHOT_CACHE in github/client.ts — PR
// refresh ticks re-ask per repo, and worktree churn can mint unbounded keys.
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
  // Why: scope per executing git host (native/WSL/SSH) so hosts with
  // different clones of the "same" path cannot cross-contaminate.
  const runtimeKey = connectionId
    ? `ssh:${connectionId}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  return [runtimeKey, repoPath].join('\0')
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

/**
 * Resolve the repository's default branch NAME (`main`, `master`, …) over the
 * transport the surrounding hosted-review call already uses. Returns null when
 * unresolvable so callers fail open (#9171 guard skipped, current behavior).
 */
export async function getRepoDefaultBranchName(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: HostedReviewLocalGitOptions = {}
): Promise<string | null> {
  const cacheKey = getRepoDefaultBranchCacheKey(repoPath, connectionId, localGitOptions)
  const now = Date.now()
  const cached = repoDefaultBranchCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.branchName
  }
  const pending = repoDefaultBranchInFlight.get(cacheKey)
  if (pending) {
    return pending
  }

  // Why: simultaneous refresh paths for one checkout should share the same
  // Git/SSH subprocess chain instead of multiplying cold-cache probes.
  const resolution = (async (): Promise<string | null> => {
    let branchName: string | null = null
    try {
      const provider = connectionId ? getSshGitProvider(connectionId) : null
      if (connectionId && !provider) {
        // Why: a dropped SSH provider must not fall back to local git — the
        // repoPath is remote, so a local run could answer for the wrong repo.
        return null
      }
      const resolutionDeadline = Date.now() + REPO_DEFAULT_BRANCH_RESOLUTION_BUDGET_MS
      // Why: the resolver can try five refs; share one deadline so an unhealthy
      // local/WSL/SSH host cannot multiply the refresh delay per fallback probe.
      const baseRef = await resolveDefaultBaseRefViaExec((argv) => {
        const timeoutMs = resolutionDeadline - Date.now()
        if (timeoutMs <= 0) {
          return Promise.reject(new Error('Default branch resolution timed out.'))
        }
        return provider
          ? provider.exec(argv, repoPath, { timeoutMs })
          : gitExecFileAsync(argv, {
              cwd: repoPath,
              ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
              timeout: timeoutMs
            })
      })
      // Same base-ref → branch-name normalization as git/repo.ts getRemoteFileUrl.
      branchName = baseRef ? baseRef.replace(/^origin\//, '') : null
    } catch {
      branchName = null
    }
    const completedAt = Date.now()
    // Why: null (failure or genuinely no default) is cached too — the resolver
    // cannot tell them apart, and the short TTL bounds the fail-open window
    // without re-probing git on every refresh tick.
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

/**
 * #9171 invariant, applied by every provider client at its branch-lookup choke
 * point: an implicit branch-name match on the repository's default branch must
 * never surface a non-open review. The explicitly linked review is exempt.
 * Resolves the default branch lazily — only for non-open, non-linked results —
 * so the common refresh path adds zero git calls.
 */
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
