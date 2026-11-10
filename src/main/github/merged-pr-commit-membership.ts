import { ghExecFileAsync } from './gh-utils'
import { githubReadExecutionScope } from './github-read-execution-scope'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'
import { githubHostExecOptions, type GitHubRepoExecOptions } from './github-api-repository'
import { githubRepoIdentityKey } from '../../shared/github/repository-identity-key'
import type { OwnerRepo } from './github-repository-identity'

import {
  MergedReviewMembershipMemo,
  type MergedReviewCommitMembership
} from '../source-control/merged-review-membership-memo'

const COMMIT_PULLS_PAGE_SIZE = 100
const COMMIT_PULLS_MAX_PAGES = 5
export type MergedPRCommitMembership = MergedReviewCommitMembership
const membershipMemo = new MergedReviewMembershipMemo()

export function resetMergedPRCommitMembershipCacheForTest(): void {
  membershipMemo.clear()
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
  const cached = membershipMemo.peek(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  // An unrun probe cannot justify clearing a durable linked PR.
  if (repositoryRateLimitGuard(args.ownerRepo, 'core', ghOptions).blocked) {
    return 'unknown'
  }
  return membershipMemo.read(cacheKey, async () => {
    try {
      // Paginate until found or a short page proves absence; a full final page leaves membership unknown.
      for (let page = 1; page <= COMMIT_PULLS_MAX_PAGES; page += 1) {
        if (page > 1 && repositoryRateLimitGuard(args.ownerRepo, 'core', ghOptions).blocked) {
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
          return 'contained'
        }
        if (entries.length < COMMIT_PULLS_PAGE_SIZE) {
          return 'not-contained'
        }
      }
      return 'unknown'
    } catch {
      // A local commit can become queryable after push; preserve links until verification succeeds.
      return 'unknown'
    }
  })
}
