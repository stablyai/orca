import { ghExecFileAsync } from './gh-utils'
import { noteRateLimitSpend, rateLimitGuard } from './rate-limit'
import type { OwnerRepo } from './github-repository-identity'

type GhExecOptions = Parameters<typeof ghExecFileAsync>[1]

// Why: a merged PR's commit set is immutable, so definitive answers — member
// or not — never change; that TTL only bounds memory. Errors (a commit not on
// GitHub yet, network) get a short TTL so a future push can flip the answer
// without the checks-panel poll re-probing every cycle.
const MEMBERSHIP_CACHE_MAX_ENTRIES = 200
const MEMBERSHIP_DEFINITIVE_TTL_MS = 6 * 60 * 60 * 1000
const MEMBERSHIP_ERROR_TTL_MS = 5 * 60 * 1000

const membershipCache = new Map<string, { value: boolean; expiresAt: number }>()

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

/**
 * Whether `commitOid` is part of pull request `prNumber` on GitHub — i.e. the
 * commit belongs to that PR's history rather than merely sharing a branch name.
 * A worktree sitting on such a commit is on the PR's own line of work (for
 * example behind web-committed suggestions or an update-branch merge), not a
 * reused branch name. Conservative on any failure: returns false.
 */
export async function isCommitPartOfMergedPR(args: {
  ownerRepo: OwnerRepo
  prNumber: number
  commitOid: string
  ghOptions: GhExecOptions
}): Promise<boolean> {
  const oid = args.commitOid.trim().toLowerCase()
  if (!/^[0-9a-f]{4,64}$/.test(oid) || !Number.isInteger(args.prNumber)) {
    return false
  }
  const owner = args.ownerRepo.owner
  const repo = args.ownerRepo.repo
  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}#${args.prNumber}@${oid}`
  const now = Date.now()
  pruneMergedPRCommitMembershipCache(now)
  const cached = membershipCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  // Why blocked → uncached false: keep the merged PR hidden without burning
  // budget; the next poll re-asks once the rate-limit window recovers.
  if (rateLimitGuard('core').blocked) {
    return false
  }
  try {
    noteRateLimitSpend('core')
    const { stdout } = await ghExecFileAsync(
      ['api', `repos/${owner}/${repo}/commits/${oid}/pulls?per_page=100`],
      args.ghOptions
    )
    const parsed = JSON.parse(stdout) as unknown
    const value =
      Array.isArray(parsed) &&
      parsed.some(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { number?: unknown }).number === args.prNumber
      )
    membershipCache.set(cacheKey, {
      value,
      expiresAt: now + MEMBERSHIP_DEFINITIVE_TTL_MS
    })
    return value
  } catch {
    // Why: the common failure is 422 for a commit never pushed to GitHub —
    // definitive "new local work" today, but a push can change it; retry later.
    membershipCache.set(cacheKey, {
      value: false,
      expiresAt: now + MEMBERSHIP_ERROR_TTL_MS
    })
    return false
  }
}
