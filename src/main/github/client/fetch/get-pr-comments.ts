import type { PRComment } from '../../../../shared/github/comment-types'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/work-items'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { mapGraphQLReactionGroups, type GitHubGraphQLReactionGroup } from '../../comment-reactions'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import { assertRateLimitBudget } from './../lookup/pr-lookup-rate-limit'
import { REVIEW_THREADS_QUERY } from './pr-review-threads-query'
/** Combine conversation comments, review summaries and GraphQL threads with resolution metadata. */
export async function getPRComments(
  repoPath: string,
  prNumber: number,
  options?: { noCache?: boolean; prRepo?: GitHubApiRepository | null },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRComment[]> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    options?.prRepo,
    connectionId,
    localGitOptions
  )
  if (connectionId && !ownerRepo) {
    throw new Error(GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE)
  }
  if (ownerRepo) {
    await assertRateLimitBudget('core', ownerRepo, ghOptions)
  }
  await acquire()
  try {
    if (ownerRepo) {
      // Explicit refresh bypasses the polling cache.
      const cacheArgs = options?.noCache ? [] : ['--cache', '60s']
      const base = `repos/${ownerRepo.owner}/${ownerRepo.repo}`

      // Retain successful comment sources when another endpoint fails.
      const reviewThreadsGuard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
      let reviewThreadsFetch: Promise<{ stdout: string; stderr: string } | null>
      if (reviewThreadsGuard.blocked) {
        reviewThreadsFetch = Promise.resolve(null)
      } else {
        noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
        reviewThreadsFetch = ghExecFileAsync(
          [
            'api',
            'graphql',
            '-f',
            `query=${REVIEW_THREADS_QUERY}`,
            '-f',
            `owner=${ownerRepo.owner}`,
            '-f',
            `repo=${ownerRepo.repo}`,
            '-F',
            `pr=${prNumber}`
          ],
          ghOptions
        )
      }
      const [issueResult, threadsResult, reviewsResult] = await Promise.allSettled([
        ghExecFileAsync(
          ['api', ...cacheArgs, `${base}/issues/${prNumber}/comments?per_page=100`],
          ghOptions
        ),
        reviewThreadsFetch,
        // Review summaries live outside issue comments and inline threads.
        ghExecFileAsync(
          ['api', ...cacheArgs, `${base}/pulls/${prNumber}/reviews?per_page=100`],
          ghOptions
        )
      ])
      noteRepositoryRateLimitSpend(ownerRepo, 'core', 2, ghOptions)

      type RESTComment = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        created_at: string
        html_url: string
      }
      let issueComments: PRComment[] = []
      if (issueResult.status === 'fulfilled') {
        issueComments = (JSON.parse(issueResult.value.stdout) as RESTComment[]).map(
          (c): PRComment => ({
            id: c.id,
            author: c.user?.login ?? 'ghost',
            authorAvatarUrl: c.user?.avatar_url ?? '',
            body: c.body ?? '',
            createdAt: c.created_at,
            url: c.html_url,
            isBot: c.user?.type === 'Bot'
          })
        )
      } else {
        console.warn('Failed to fetch issue comments:', issueResult.reason)
      }

      type GQLThread = {
        id: string
        isResolved: boolean
        line: number | null
        startLine: number | null
        originalLine: number | null
        originalStartLine: number | null
        comments: {
          nodes: {
            id: string
            databaseId: number
            author: { __typename?: string; login: string; avatarUrl: string } | null
            body: string
            createdAt: string
            url: string
            path: string
            reactionGroups?: GitHubGraphQLReactionGroup[] | null
          }[]
        }
      }
      type GQLIssueComment = {
        id: string
        databaseId: number
        author: { __typename?: string; login: string; avatarUrl: string } | null
        body: string
        createdAt: string
        url: string
        reactionGroups?: GitHubGraphQLReactionGroup[] | null
      }
      let graphQLReviewSummaries: PRComment[] | undefined
      const reviewComments: PRComment[] = []
      if (threadsResult.status === 'fulfilled' && threadsResult.value) {
        const threadsData = JSON.parse(threadsResult.value.stdout) as {
          data?: {
            repository?: {
              pullRequest?: {
                reviewThreads?: { nodes?: GQLThread[] | null } | null
                comments?: { nodes?: GQLIssueComment[] | null } | null
                reviews?: { nodes?: GQLIssueComment[] | null } | null
              } | null
            } | null
          } | null
        }
        // GraphQL can exit 0 with a null repository and errors; retain the successful REST halves.
        const pullRequest = threadsData.data?.repository?.pullRequest
        if (!pullRequest) {
          console.warn('Review threads response missing pullRequest; keeping REST results')
        }
        const graphQLIssueComments = (pullRequest?.comments?.nodes ?? []).map((c): PRComment => ({
          id: c.databaseId,
          author: c.author?.login ?? 'ghost',
          authorAvatarUrl: c.author?.avatarUrl ?? '',
          body: c.body ?? '',
          createdAt: c.createdAt,
          url: c.url,
          isBot: c.author?.__typename === 'Bot',
          reactionSubjectId: c.id,
          reactions: mapGraphQLReactionGroups(c.reactionGroups)
        }))
        if (graphQLIssueComments.length > 0) {
          issueComments = graphQLIssueComments
        }
        // Incomplete GraphQL payloads must preserve REST review summaries.
        graphQLReviewSummaries = pullRequest
          ? (pullRequest.reviews?.nodes ?? [])
              .filter((review) => review.body?.trim())
              .map((review): PRComment => ({
                id: review.databaseId,
                author: review.author?.login ?? 'ghost',
                authorAvatarUrl: review.author?.avatarUrl ?? '',
                body: review.body,
                createdAt: review.createdAt,
                url: review.url,
                isBot: review.author?.__typename === 'Bot',
                reactionSubjectId: review.id,
                reactions: mapGraphQLReactionGroups(review.reactionGroups)
              }))
          : undefined

        const threads = pullRequest?.reviewThreads?.nodes ?? []
        for (const thread of threads) {
          for (const c of thread.comments.nodes) {
            reviewComments.push({
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
              isOutdated: thread.line == null,
              // Outdated code nulls current line numbers; retain original positions.
              line: thread.line ?? thread.originalLine ?? undefined,
              startLine: thread.startLine ?? thread.originalStartLine ?? undefined
            })
          }
        }
      } else {
        if (threadsResult.status === 'rejected') {
          console.warn('Failed to fetch review threads:', threadsResult.reason)
        }
      }

      // Empty-body approvals add no conversation text.
      type RESTReview = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        state: string
        submitted_at: string
        html_url: string
      }
      let reviewSummaries: PRComment[] = []
      if (graphQLReviewSummaries) {
        reviewSummaries = graphQLReviewSummaries
      } else if (reviewsResult.status === 'fulfilled') {
        reviewSummaries = (JSON.parse(reviewsResult.value.stdout) as RESTReview[])
          .filter((r) => r.body?.trim())
          .map((r): PRComment => ({
            id: r.id,
            author: r.user?.login ?? 'ghost',
            authorAvatarUrl: r.user?.avatar_url ?? '',
            body: r.body,
            createdAt: r.submitted_at,
            url: r.html_url,
            isBot: r.user?.type === 'Bot'
          }))
      } else {
        console.warn('Failed to fetch review summaries:', reviewsResult.reason)
      }

      const all = [...issueComments, ...reviewComments, ...reviewSummaries]
      all.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      return all
    }

    // Legacy local fallback returns issue-level comments only.
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(prNumber), '--json', 'comments'],
      ghOptions
    )
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const data = JSON.parse(stdout) as {
      comments: {
        author: { login: string }
        body: string
        createdAt: string
        url: string
      }[]
    }
    return (data.comments ?? []).map((c, i) => ({
      id: i,
      author: c.author?.login ?? 'ghost',
      authorAvatarUrl: '',
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url ?? ''
    }))
  } catch (err) {
    console.warn('getPRComments failed:', err)
    return []
  } finally {
    release()
  }
}
