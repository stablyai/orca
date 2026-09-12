import { isBotPRCommentAuthor } from '../../../../shared/pr-comment-audience'
import { ghExecFileAsync, type OwnerRepo } from '../../gh-utils'
import { githubHostExecOptions } from '../../github-api-repository'
import { mapPRState } from '../../mappers'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'
import type { PullRequestLookupData } from './pull-request-lookup-data'

// Why: thread resolution is GraphQL-only; `gh pr view --json` has no field for it.
const UNRESOLVED_REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 1) { nodes { author { __typename login } } }
        }
      }
    }
  }
}`

export type ReviewThreadResolutionNode = {
  isResolved?: boolean
  comments?: {
    nodes?: ({
      author?: { __typename?: string; login?: string } | null
    } | null)[]
  }
}

export function countUnresolvedReviewThreadNodes(
  nodes: readonly (ReviewThreadResolutionNode | null)[]
): number {
  let count = 0
  for (const node of nodes) {
    if (!node || node.isResolved === true) {
      continue
    }
    const author = node.comments?.nodes?.[0]?.author
    // Why: match the PR-comments panel's bot filter so a noisy CI bot doesn't light up every card.
    if (author && isBotPRCommentAuthor(author.login ?? '', author.__typename === 'Bot')) {
      continue
    }
    count += 1
  }
  return count
}

/** Best-effort: undefined when the PR is not open, the GraphQL budget is low, or the call fails. */
export async function fetchUnresolvedReviewCommentCount(
  ownerRepo: OwnerRepo,
  data: PullRequestLookupData,
  ghOptions: GhExecOptions
): Promise<number | undefined> {
  const state = mapPRState(data.state, data.isDraft)
  if (state !== 'open' && state !== 'draft') {
    return undefined
  }
  try {
    let count = 0
    let cursor: string | undefined
    while (true) {
      if (repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions).blocked) {
        return undefined
      }
      noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          'graphql',
          '-f',
          `query=${UNRESOLVED_REVIEW_THREADS_QUERY}`,
          '-f',
          `owner=${ownerRepo.owner}`,
          '-f',
          `repo=${ownerRepo.repo}`,
          '-F',
          `pr=${data.number}`,
          ...(cursor ? ['-f', `cursor=${cursor}`] : [])
        ],
        { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
      )
      const parsed = JSON.parse(stdout) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviewThreads?: {
                nodes?: (ReviewThreadResolutionNode | null)[]
                pageInfo?: { hasNextPage: boolean; endCursor?: string | null }
              }
            }
          }
        }
      }
      const threads = parsed.data?.repository?.pullRequest?.reviewThreads
      if (!Array.isArray(threads?.nodes) || !threads.pageInfo) {
        return undefined
      }
      count += countUnresolvedReviewThreadNodes(threads.nodes)
      if (!threads.pageInfo.hasNextPage) {
        return count
      }
      const nextCursor = threads.pageInfo.endCursor
      if (!nextCursor || nextCursor === cursor) {
        return undefined
      }
      cursor = nextCursor
    }
  } catch {
    return undefined
  }
}
