import type { OwnerRepo } from '../../gh-utils'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import {
  pullRequestHeadRepository,
  type PullRequestLookupData,
  type PullRequestLookupPolicy
} from './pull-request-lookup-data'

export type GitHubReviewHead = { repo: OwnerRepo | null; branch: string }

function isFromReviewHead(
  data: PullRequestLookupData,
  prRepo: OwnerRepo | null,
  head: GitHubReviewHead
): boolean {
  if (data.headRefName !== head.branch) {
    return false
  }
  const prHeadRepo = pullRequestHeadRepository(data, prRepo)
  return (
    !prHeadRepo ||
    !head.repo ||
    githubRepoIdentityKey(prHeadRepo) === githubRepoIdentityKey(head.repo)
  )
}

/**
 * Accepts a remembered PR number only when that PR's head is this branch's review head, so a
 * number cached from a wrong match (#26948, #27811) is dropped instead of re-shown. Without a head
 * (detached HEAD mid-rebase) there is nothing to compare, so the remembered PR stays.
 */
export function createReviewHeadPRPolicy(head: GitHubReviewHead | null): PullRequestLookupPolicy {
  const rejected = new Set<string>()
  const rejectedPRUrls = new Set<string>()
  return {
    rejectedPRUrls,
    async accepts(data, prRepo) {
      if (!head || isFromReviewHead(data, prRepo, head)) {
        return true
      }
      if (prRepo) {
        rejected.add(`${githubRepoIdentityKey(prRepo)}#${data.number}`)
      }
      if (data.url) {
        rejectedPRUrls.add(data.url)
      }
      return false
    },
    isRejected(prRepo, number) {
      return rejected.has(`${githubRepoIdentityKey(prRepo)}#${number}`)
    }
  }
}
