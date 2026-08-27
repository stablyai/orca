import type { PullRequestMergeQueueEntry } from '../../../../shared/github/pull-request-types'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'

/**
 * `mergeQueueEntry` present ⇒ the PR is in the queue. Keeping presence as the one
 * discriminator (rather than a separate boolean) is what lets the wire carry
 * `open` + entry and the client derive `queued` with no second signal to keep in sync.
 */
export type PullRequestMergeQueueMembership = {
  mergeQueueEntry?: PullRequestMergeQueueEntry
}

const NOT_QUEUED: PullRequestMergeQueueMembership = {}

const MERGE_QUEUE_ENTRY_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      isInMergeQueue
      mergeQueueEntry { state position estimatedTimeToMerge enqueuedAt }
    }
  }
}`

function coerceNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Per-PR GraphQL probe for GitHub merge-queue membership. `state`/`mergeStateStatus`
 * cannot express it, so this is the only source. Callers must gate on the base
 * branch actually requiring a merge queue — repos without one pay nothing.
 * Any failure degrades to "not queued" so a PR refresh never breaks on it.
 */
export async function detectPullRequestMergeQueueEntry(
  ownerRepo: GitHubApiRepository,
  prNumber: number,
  ghOptions: GhExecOptions
): Promise<PullRequestMergeQueueMembership> {
  const guard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
  if (guard.blocked) {
    return NOT_QUEUED
  }
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${MERGE_QUEUE_ENTRY_QUERY}`,
        '-f',
        `owner=${ownerRepo.owner}`,
        '-f',
        `repo=${ownerRepo.repo}`,
        '-F',
        `number=${prNumber}`
      ],
      { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
    )
    const parsed = JSON.parse(stdout) as {
      data?: {
        repository?: {
          pullRequest?: {
            isInMergeQueue?: unknown
            mergeQueueEntry?: {
              state?: unknown
              position?: unknown
              estimatedTimeToMerge?: unknown
              enqueuedAt?: unknown
            } | null
          } | null
        } | null
      }
    }
    const pullRequest = parsed.data?.repository?.pullRequest
    if (pullRequest?.isInMergeQueue !== true) {
      return NOT_QUEUED
    }
    // Why: GitHub can report membership without an entry payload; synthesise one so
    // presence stays a faithful discriminator instead of silently reading as not-queued.
    const entry = pullRequest.mergeQueueEntry
    return {
      mergeQueueEntry: {
        state: typeof entry?.state === 'string' ? entry.state : 'QUEUED',
        position: coerceNullableNumber(entry?.position),
        estimatedTimeToMerge: coerceNullableNumber(entry?.estimatedTimeToMerge),
        enqueuedAt: typeof entry?.enqueuedAt === 'string' ? entry.enqueuedAt : null
      }
    }
  } catch {
    // Why: a failed probe must not demote a PR or abort the refresh; "not queued" is the safe default.
    return NOT_QUEUED
  }
}
