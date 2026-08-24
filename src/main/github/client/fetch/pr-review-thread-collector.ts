import type { PRComment } from '../../../../shared/github/comment-types'
import { ghExecFileAsync } from '../../gh-utils'
import type { GitHubApiRepository } from '../../github-api-repository'
import { mapGraphQLReactionGroups, type GitHubGraphQLReactionGroup } from '../../comment-reactions'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import { REVIEW_THREADS_PAGE_QUERY } from './pr-review-threads-query'

// Why: bounded pagination — 10 pages × 50 threads covers any realistic PR; past that we log the truncation.
const MAX_REVIEW_THREAD_PAGES = 10

type GQLThread = {
  id: string
  isResolved: boolean
  isOutdated?: boolean | null
  path?: string | null
  diffSide?: 'LEFT' | 'RIGHT' | null
  line: number | null
  startLine: number | null
  originalLine: number | null
  originalStartLine: number | null
  comments: {
    nodes: {
      id: string
      databaseId: number
      state?: string | null
      diffHunk?: string | null
      author: { __typename?: string; login: string; avatarUrl: string } | null
      body: string
      createdAt: string
      url: string
      path: string
      reactionGroups?: GitHubGraphQLReactionGroup[] | null
    }[]
  }
}

export type GQLThreadConnection = {
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null
  nodes?: GQLThread[] | null
}

export function threadCommentsToPRComments(thread: GQLThread): PRComment[] {
  const rootDiffHunk = thread.comments.nodes[0]?.diffHunk ?? undefined
  return thread.comments.nodes.map((c, index): PRComment => {
    const isPending = c.state === 'PENDING'
    return {
      id: c.databaseId,
      author: c.author?.login ?? 'ghost',
      authorAvatarUrl: c.author?.avatarUrl ?? '',
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url,
      isBot: c.author?.__typename === 'Bot',
      reactionSubjectId: c.id,
      reactions: mapGraphQLReactionGroups(c.reactionGroups),
      path: c.path,
      threadId: thread.id,
      isResolved: thread.isResolved,
      // Why: prefer the server's isOutdated; fall back to the null-line inference when the server returns null.
      isOutdated: thread.isOutdated ?? thread.line == null,
      // Why: GitHub nulls line/startLine when the commented code is outdated (e.g. force-push); originalLine preserves the original numbers.
      line: thread.line ?? thread.originalLine ?? undefined,
      startLine: thread.startLine ?? thread.originalStartLine ?? undefined,
      isPending: isPending || undefined,
      diffSide: thread.diffSide ?? undefined,
      // Why: only the root comment carries the thread's anchor hunk; replies share it.
      diffHunk: index === 0 ? rootDiffHunk : undefined
    }
  })
}

/** Follow reviewThreads pagination past the first page; large PRs silently lose later threads otherwise. */
export async function fetchRemainingReviewThreadPages(args: {
  ownerRepo: GitHubApiRepository
  ghOptions: Parameters<typeof ghExecFileAsync>[1]
  prNumber: number
  pageInfo: GQLThreadConnection['pageInfo']
}): Promise<PRComment[]> {
  const { ownerRepo, ghOptions, prNumber } = args
  const collected: PRComment[] = []
  let pageInfo = args.pageInfo
  let fetchedPages = 1
  try {
    return await collectPages()
  } catch (err) {
    // Why: mirror the allSettled posture of the first page — a transient page-2
    // failure must not blank out the threads already fetched.
    console.warn('Review thread pagination failed; keeping earlier pages:', err)
    return collected
  }

  async function collectPages(): Promise<PRComment[]> {
    while (pageInfo?.hasNextPage && pageInfo.endCursor) {
      if (fetchedPages >= MAX_REVIEW_THREAD_PAGES) {
        console.warn(
          `Review threads truncated after ${String(fetchedPages)} pages for PR #${String(prNumber)}`
        )
        break
      }
      const pageGuard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
      if (pageGuard.blocked) {
        console.warn('Review thread pagination stopped by rate-limit guard')
        break
      }
      noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
      const pageResult = await ghExecFileAsync(
        [
          'api',
          'graphql',
          '-f',
          `query=${REVIEW_THREADS_PAGE_QUERY}`,
          '-f',
          `owner=${ownerRepo.owner}`,
          '-f',
          `repo=${ownerRepo.repo}`,
          '-F',
          `pr=${prNumber}`,
          '-f',
          `after=${pageInfo.endCursor}`
        ],
        ghOptions
      )
      fetchedPages += 1
      const pageData = JSON.parse(pageResult.stdout) as {
        data?: {
          repository?: {
            pullRequest?: { reviewThreads?: GQLThreadConnection | null } | null
          } | null
        } | null
      }
      const pageConnection = pageData.data?.repository?.pullRequest?.reviewThreads
      if (!pageConnection) {
        console.warn('Review thread page missing pullRequest; stopping pagination')
        break
      }
      for (const thread of pageConnection.nodes ?? []) {
        collected.push(...threadCommentsToPRComments(thread))
      }
      pageInfo = pageConnection.pageInfo
    }
    return collected
  }
}
