import { ghExecFileAsync } from './gh-utils'
import { githubReadExecutionScope } from './github-read-execution-scope'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'
import { githubHostExecOptions, type GitHubRepoExecOptions } from './github-api-repository'
import { githubRepoIdentityKey } from '../../shared/github/repository-identity-key'
import type { OwnerRepo } from './github-repository-identity'

// Definitive merged-commit membership is immutable; errors expire sooner so later pushes can resolve unknowns.
const MEMBERSHIP_CACHE_MAX_ENTRIES = 200
const MEMBERSHIP_DEFINITIVE_TTL_MS = 6 * 60 * 60 * 1000
const MEMBERSHIP_ERROR_TTL_MS = 5 * 60 * 1000
const COMMIT_PULLS_PAGE_SIZE = 100
// Full pages through the cap cannot prove absence; keep pathological commit fan-out unknown.
const COMMIT_PULLS_MAX_PAGES = 5

export type MergedPRCommitMembership = 'contained' | 'not-contained' | 'unknown'

const membershipCache = new Map<string, { value: MergedPRCommitMembership; expiresAt: number }>()

function pruneMergedPRCommitMembershipCache(now = Date.now()): void {
  for (const [cacheKey, cached] of membershipCache) {
    if (cached.expiresAt <= now) {
      membershipCache.delete(cacheKey)
    }
  }
  while (membershipCache.size > MEMBERSHIP_CACHE_MAX_ENTRIES) {
    const oldestKey = membershipCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    membershipCache.delete(oldestKey)
  }
}

export function resetMergedPRCommitMembershipCacheForTest(): void {
  membershipCache.clear()
}

/** Check PR-history membership rather than branch-name reuse; failures return unknown. */
export async function isCommitPartOfMergedPR(args: {
  ownerRepo: OwnerRepo
  prNumber: number
  commitOid: string
  ghOptions: GitHubRepoExecOptions
}): Promise<MergedPRCommitMembership> {
  const oid = args.commitOid.trim().toLowerCase()
  if (!/^[0-9a-f]{4,64}$/.test(oid) || !Number.isInteger(args.prNumber)) {
    return 'unknown'
  }
  const owner = args.ownerRepo.owner
  const repo = args.ownerRepo.repo
  const ghOptions = { ...args.ghOptions, ...githubHostExecOptions(args.ownerRepo) }
  const cacheKey = `${githubReadExecutionScope(ghOptions)}\0${githubRepoIdentityKey(args.ownerRepo)}#${args.prNumber}@${oid}`
  const now = Date.now()
  pruneMergedPRCommitMembershipCache(now)
  const cached = membershipCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  // An unrun probe cannot justify clearing a durable linked PR.
  if (repositoryRateLimitGuard(args.ownerRepo, 'core', ghOptions).blocked) {
    return 'unknown'
  }
  try {
    // Paginate until found or a short page proves absence; a full final page leaves membership unknown.
    for (let page = 1; page <= COMMIT_PULLS_MAX_PAGES; page += 1) {
      if (page > 1 && repositoryRateLimitGuard(args.ownerRepo, 'core', ghOptions).blocked) {
        membershipCache.set(cacheKey, {
          value: 'unknown',
          expiresAt: now + MEMBERSHIP_ERROR_TTL_MS
        })
        return 'unknown'
      }
      noteRepositoryRateLimitSpend(args.ownerRepo, 'core', 1, ghOptions)
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          `repos/${owner}/${repo}/commits/${oid}/pulls?per_page=${COMMIT_PULLS_PAGE_SIZE}&page=${page}`
        ],
        ghOptions
      )
      const parsed = JSON.parse(stdout) as unknown
      // Non-array success is unverified, not evidence that a durable link should be cleared.
      if (!Array.isArray(parsed)) {
        membershipCache.set(cacheKey, {
          value: 'unknown',
          expiresAt: now + MEMBERSHIP_ERROR_TTL_MS
        })
        return 'unknown'
      }
      const entries = parsed
      const contained = entries.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { number?: unknown }).number === args.prNumber
      )
      if (contained) {
        membershipCache.set(cacheKey, {
          value: 'contained',
          expiresAt: now + MEMBERSHIP_DEFINITIVE_TTL_MS
        })
        return 'contained'
      }
      if (entries.length < COMMIT_PULLS_PAGE_SIZE) {
        membershipCache.set(cacheKey, {
          value: 'not-contained',
          expiresAt: now + MEMBERSHIP_DEFINITIVE_TTL_MS
        })
        return 'not-contained'
      }
    }
    membershipCache.set(cacheKey, {
      value: 'unknown',
      expiresAt: now + MEMBERSHIP_ERROR_TTL_MS
    })
    return 'unknown'
  } catch {
    // A local commit can become queryable after push; preserve links until verification succeeds.
    membershipCache.set(cacheKey, {
      value: 'unknown',
      expiresAt: now + MEMBERSHIP_ERROR_TTL_MS
    })
    return 'unknown'
  }
}
