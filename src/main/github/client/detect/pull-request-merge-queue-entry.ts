import type { PRState } from '../../../../shared/github/pull-request-types'
import {
  parseReviewMergeQueueEntry,
  type ReviewMergeQueueEntry
} from '../../../../shared/review-merge-queue-entry'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'

// Why: `gh pr view --json` exposes neither field, so queue membership needs its own GraphQL read.
const MERGE_QUEUE_ENTRY_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      isInMergeQueue
      mergeQueueEntry { position state }
    }
  }
}`

/** Only open PRs whose base branch is known to use a merge queue can be queued. */
export function shouldFetchPullRequestMergeQueueEntry(pr: {
  state: PRState
  mergeQueueRequired?: boolean | null
}): boolean {
  return pr.state === 'open' && pr.mergeQueueRequired === true
}

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/** `undefined` means GitHub's answer is unknown; `null` means the PR is not queued. */
export function parsePullRequestMergeQueueEntryResponse(
  stdout: string
): ReviewMergeQueueEntry | null | undefined {
  const pullRequest = readField(
    readField(readField(JSON.parse(stdout), 'data'), 'repository'),
    'pullRequest'
  )
  const isInMergeQueue = readField(pullRequest, 'isInMergeQueue')
  if (typeof isInMergeQueue !== 'boolean') {
    return undefined
  }
  if (!isInMergeQueue) {
    return null
  }
  return (
    parseReviewMergeQueueEntry(readField(pullRequest, 'mergeQueueEntry')) ?? {
      position: null,
      state: null
    }
  )
}

export async function fetchPullRequestMergeQueueEntry(
  ownerRepo: GitHubApiRepository,
  number: number,
  ghOptions: GhExecOptions
): Promise<ReviewMergeQueueEntry | null | undefined> {
  if (repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions).blocked) {
    return undefined
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
        `number=${number}`
      ],
      { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
    )
    return parsePullRequestMergeQueueEntryResponse(stdout)
  } catch {
    // Why: queue status is additive; a failed probe must not fail the PR lookup it decorates.
    return undefined
  }
}
