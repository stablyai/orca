import { GITHUB_BODY_MEDIA_TYPE } from '../../body-image-urls'
import type { PRComment } from '../../../../shared/github/comment-types'
import { runCoalescedProbe, type CoalescedProbes } from '../../../git/remotes/coalesced-probe'
import { extractExecError } from '../../../git/exec-error'
import { githubReadExecutionScope } from '../../github-read-execution-scope'
import { GITHUB_WORK_ITEMS_SSH_REMOTE_REQUIRED_MESSAGE } from '../../../../shared/github/work-item-ssh-error'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import { assertRateLimitBudget } from './../lookup/pr-lookup-rate-limit'
import { REVIEW_THREADS_QUERY } from './pr-review-threads-query'
import type { parsePRConversationResponse } from './pr-conversation-response'
import { parseRestPRCommentPage } from './pr-conversation-response'
import {
  readCompletePRConversation,
  IncompletePRConversationError
} from './pr-conversation-pagination'
import { readViewerLogin } from './authenticated-viewer'
/** Combine conversation comments, review summaries and GraphQL threads with resolution metadata. */
async function readPRComments(
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
  await acquire()
  let restBudgetFailed = false
  try {
    if (ownerRepo) {
      const base = `repos/${ownerRepo.owner}/${ownerRepo.repo}`

      // Retain successful comment sources when another endpoint fails.
      const reviewThreadsGuard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
      let threadsResult: { stdout: string } | null = null
      if (reviewThreadsGuard.blocked) {
        threadsResult = null
      } else {
        noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
        try {
          threadsResult = await ghExecFileAsync(
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
        } catch (error) {
          // gh exits nonzero for partial GraphQL errors; keep the successful sources.
          const { stdout, stderr } = extractExecError(error)
          threadsResult = stdout ? { stdout } : null
          console.warn('Failed to fetch review threads:', stderr)
        }
      }

      let conversation: ReturnType<typeof parsePRConversationResponse> = { reviewComments: [] }
      if (threadsResult) {
        try {
          conversation = await readCompletePRConversation(
            threadsResult.stdout,
            async (query, variables) => {
              await assertRateLimitBudget('graphql', ownerRepo, ghOptions)
              noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
              const args = ['api', 'graphql', '-f', `query=${query}`]
              if (!('threadId' in variables)) {
                args.push(
                  '-f',
                  `owner=${ownerRepo.owner}`,
                  '-f',
                  `repo=${ownerRepo.repo}`,
                  '-F',
                  `pr=${prNumber}`
                )
              }
              for (const [key, value] of Object.entries(variables)) {
                args.push('-f', `${key}=${value}`)
              }
              try {
                return (await ghExecFileAsync(args, ghOptions)).stdout
              } catch (error) {
                const { stdout } = extractExecError(error)
                if (stdout) {
                  return stdout
                }
                throw error
              }
            }
          )
        } catch (error) {
          if (error instanceof IncompletePRConversationError) {
            throw error
          }
          console.warn('Invalid review threads response; falling back to REST')
        }
      }
      const { issueComments, reviewSummaries, reviewComments } = conversation

      // REST has no viewerDidAuthor, so conversation comments match the reading account's login instead.
      let restViewer: Promise<string | null> | undefined
      let restFailure: unknown
      const readRestSource = async (endpoint: string, reviews: boolean): Promise<PRComment[]> => {
        await assertRateLimitBudget('core', ownerRepo, ghOptions).catch((error: unknown) => {
          restBudgetFailed = true
          throw error
        })
        const comments: PRComment[] = []
        const ids = new Set<number>()
        const rawIds = new Set<number>()
        let page = 1
        try {
          while (true) {
            if (restFailure) {
              throw restFailure
            }
            if (page > 1) {
              await assertRateLimitBudget('core', ownerRepo, ghOptions)
            }
            if (restFailure) {
              throw restFailure
            }
            const needsViewer = !restViewer
            restViewer ??= readViewerLogin(ghOptions)
            noteRepositoryRateLimitSpend(ownerRepo, 'core', needsViewer ? 2 : 1, ghOptions)
            const [{ stdout }, viewer] = await Promise.all([
              ghExecFileAsync(
                [
                  'api',
                  '-H',
                  GITHUB_BODY_MEDIA_TYPE,
                  page === 1 ? endpoint : `${endpoint}&page=${page}`
                ],
                ghOptions
              ),
              restViewer
            ])
            const result = parseRestPRCommentPage(stdout, reviews, viewer)
            const advanced = result.rawIds.some((id) => !rawIds.has(id))
            for (const id of result.rawIds) {
              rawIds.add(id)
            }
            for (const comment of result.comments) {
              if (!ids.has(comment.id)) {
                ids.add(comment.id)
                comments.push(comment)
              }
            }
            if (!result.hasMore) {
              return comments
            }
            if (!advanced) {
              throw new Error('GitHub REST conversation page did not advance')
            }
            page += 1
          }
        } catch (error) {
          if (page > 1) {
            restFailure ??= new IncompletePRConversationError(
              'GitHub REST conversation pagination failed',
              {
                cause: error
              }
            )
            throw restFailure
          }
          console.warn('Failed to fetch PR conversation fallback:', extractExecError(error).stderr)
          return []
        }
      }

      const results = await Promise.allSettled([
        issueComments === undefined
          ? readRestSource(`${base}/issues/${prNumber}/comments?per_page=100`, false)
          : null,
        reviewSummaries === undefined
          ? readRestSource(`${base}/pulls/${prNumber}/reviews?per_page=100`, true)
          : null
      ])
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason
        }
      }
      const [issueResult, reviewsResult] = results.map((result) =>
        result.status === 'fulfilled' ? result.value : null
      )
      const all = [
        ...(issueComments ?? issueResult ?? []),
        ...reviewComments,
        ...(reviewSummaries ?? reviewsResult ?? [])
      ]
      return all
        .map((comment) => ({ comment, time: Date.parse(comment.createdAt) }))
        .sort((a, b) => a.time - b.time)
        .map(({ comment }) => comment)
    }

    // Legacy local fallback returns issue-level comments only.
    const { stdout } = await ghExecFileAsync(
      ['pr', 'view', String(prNumber), '--json', 'comments'],
      ghOptions
    )
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const data: {
      comments: {
        author: { login: string }
        body: string
        createdAt: string
        url: string
        viewerDidAuthor?: boolean
      }[]
    } = JSON.parse(stdout)
    return (data.comments ?? []).map((c, i) => ({
      id: i,
      author: c.author?.login ?? 'ghost',
      authorAvatarUrl: '',
      body: c.body ?? '',
      createdAt: c.createdAt,
      url: c.url ?? '',
      ...(c.viewerDidAuthor === true ? { viewerDidAuthor: true } : {})
    }))
  } catch (err) {
    if (restBudgetFailed || err instanceof IncompletePRConversationError) {
      throw err
    }
    console.warn('getPRComments failed:', err)
    return []
  } finally {
    release()
  }
}

const commentReads: CoalescedProbes<PRComment[]> = new Map()

export function getPRComments(
  repoPath: string,
  prNumber: number,
  options?: { noCache?: boolean; prRepo?: GitHubApiRepository | null },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRComment[]> {
  // Forced refreshes often follow a mutation, so they must not join a read that started before it.
  if (options?.noCache) {
    return readPRComments(repoPath, prNumber, options, connectionId, localGitOptions)
  }
  const key = JSON.stringify([
    repoPath,
    prNumber,
    options?.prRepo ?? null,
    connectionId ?? null,
    githubReadExecutionScope(localGitOptions)
  ])
  return runCoalescedProbe(commentReads, key, () =>
    readPRComments(repoPath, prNumber, options, connectionId, localGitOptions)
  )
}
