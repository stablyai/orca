import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getPRComments } from './client/fetch/get-pr-comments'
import { resetGraphQLRateLimitGuardMocks } from './client-test-harness'

const { ghExecFileAsyncMock, rateLimitGuardMock, noteRateLimitSpendMock } = clientMocks

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const options = { prRepo: repository }
const comment = {
  id: 'IC_10',
  databaseId: 10,
  author: null,
  body: 'Conversation',
  createdAt: '2026-04-01T00:00:00Z',
  url: 'https://example.test/comment'
}
function response(pr: unknown, errors?: unknown): { stdout: string } {
  return { stdout: JSON.stringify({ data: { repository: { pullRequest: pr } }, errors }) }
}
function completeResponse() {
  return response({
    comments: { nodes: [comment] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] }
  })
}

describe('PR conversation request reuse', () => {
  beforeEach(() => resetGraphQLRateLimitGuardMocks(clientMocks))
  afterEach(() => vi.restoreAllMocks())

  it('shares simultaneous reads, spends no REST quota, and reads fresh data after completion', async () => {
    ghExecFileAsyncMock.mockResolvedValue(completeResponse())
    const results = await Promise.all(
      Array.from({ length: 8 }, () => getPRComments('/repo', 7, options))
    )
    expect(
      results.every(
        (comments) => comments.length === 1 && comments[0].reactionSubjectId === 'IC_10'
      )
    ).toBe(true)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(noteRateLimitSpendMock.mock.calls).toEqual([['graphql']])
    ghExecFileAsyncMock.mockResolvedValue(
      response({ comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } })
    )
    await expect(getPRComments('/repo', 7, options)).resolves.toEqual([])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('loads reactions and threads even when the REST allowance is exhausted', async () => {
    rateLimitGuardMock.mockImplementation((bucket) =>
      bucket === 'core'
        ? { blocked: true, remaining: 0, limit: 5000, resetAt: 1800000000 }
        : { blocked: false }
    )
    ghExecFileAsyncMock.mockResolvedValue(completeResponse())
    await expect(getPRComments('/repo', 7, options)).resolves.toMatchObject([
      { id: 10, body: 'Conversation' }
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('orders submitted draft reviews by submission time while preserving comment creation time', async () => {
    ghExecFileAsyncMock.mockResolvedValue(
      response({
        comments: { nodes: [comment] },
        reviews: {
          nodes: [
            {
              ...comment,
              id: 'PRR_11',
              databaseId: 11,
              body: 'Submitted review',
              createdAt: '2026-03-01T00:00:00Z',
              submittedAt: '2026-04-02T00:00:00Z'
            }
          ]
        },
        reviewThreads: { nodes: [] }
      })
    )
    await expect(getPRComments('/repo', 7, options)).resolves.toMatchObject([
      { id: 10, createdAt: comment.createdAt },
      { id: 11, createdAt: '2026-04-02T00:00:00Z' }
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'preserves quota failures when REST recovery is needed (GraphQL blocked: %s)',
    async (graphQLBlocked) => {
      rateLimitGuardMock.mockImplementation((bucket) =>
        bucket === 'core' || graphQLBlocked
          ? { blocked: true, remaining: 0, limit: 5000, resetAt: 1800000000 }
          : { blocked: false }
      )
      ghExecFileAsyncMock.mockResolvedValue(
        response({ comments: { nodes: [comment] }, reviews: null, reviewThreads: { nodes: [] } })
      )
      await expect(getPRComments('/repo', 7, options)).rejects.toThrow('GitHub core rate limit')
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(graphQLBlocked ? 0 : 1)
    }
  )

  it('keeps valid inline comments when another comment has no numeric database ID', async () => {
    ghExecFileAsyncMock.mockResolvedValue(
      response({
        comments: { nodes: [comment] },
        reviews: { nodes: [] },
        reviewThreads: {
          nodes: [
            {
              id: 'PRRT_1',
              isResolved: true,
              line: null,
              startLine: null,
              originalLine: 8,
              originalStartLine: 6,
              comments: {
                nodes: [
                  { ...comment, databaseId: null, path: 'src/app.ts' },
                  {
                    ...comment,
                    id: 'PRRC_11',
                    databaseId: 11,
                    body: 'Valid inline',
                    path: 'src/app.ts'
                  }
                ]
              }
            }
          ]
        }
      })
    )
    await expect(getPRComments('/repo', 7, options)).resolves.toMatchObject([
      { id: 10, body: 'Conversation' },
      { id: 11, body: 'Valid inline', line: 8, startLine: 6, isOutdated: true, isResolved: true }
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('recovers only the failed GraphQL source from nonzero-exit partial data', async () => {
    const partial = response(
      { comments: { nodes: [comment] }, reviews: null, reviewThreads: { nodes: [] } },
      [{ message: 'Review unavailable', path: ['repository', 'pullRequest', 'reviews'] }]
    )
    ghExecFileAsyncMock
      .mockRejectedValueOnce(Object.assign(new Error('GraphQL error'), partial))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 11,
            user: null,
            body: 'Review summary',
            submitted_at: '2026-04-01T00:01:00Z',
            html_url: 'https://example.test/review'
          }
        ])
      })
    const comments = await getPRComments('/repo', 7, { ...options, noCache: true })
    expect(comments.map((c) => c.body)).toEqual(['Conversation', 'Review summary'])
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toEqual([
      'api',
      'repos/acme/widgets/pulls/7/reviews?per_page=100'
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('retains the successful REST source when GraphQL and the other REST source fail', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(response(null))
      .mockRejectedValueOnce(new Error('Issue comments failed'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 11,
            user: null,
            body: 'Recovered review',
            submitted_at: '2026-04-01T00:01:00Z',
            html_url: 'https://example.test/review'
          }
        ])
      })
    await expect(getPRComments('/repo', 7, options)).resolves.toMatchObject([
      { id: 11, body: 'Recovered review' }
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('does not let a missing reviews connection hide REST review summaries', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(response({ comments: { nodes: [] }, reviewThreads: { nodes: [] } }))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 11,
            user: null,
            body: 'Recovered review',
            submitted_at: '2026-04-01T00:01:00Z',
            html_url: 'https://example.test/review'
          }
        ])
      })
    await expect(getPRComments('/repo', 7, options)).resolves.toMatchObject([
      { body: 'Recovered review' }
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('never shares explicit refreshes and keeps host, environment, and execution runtimes separate', async () => {
    ghExecFileAsyncMock.mockResolvedValue(completeResponse())
    const reads = [
      getPRComments('/repo', 7, options),
      getPRComments('/repo', 7, { ...options, noCache: true }),
      getPRComments('/repo', 7, { ...options, noCache: true }),
      getPRComments('/repo', 7, { prRepo: { ...repository, host: 'github.example.com' } }),
      getPRComments('/repo', 7, options, null, { wslDistro: 'Ubuntu' }),
      getPRComments('/repo', 7, options, 'ssh-1')
    ]
    vi.stubEnv('GH_TOKEN', 'different-test-account')
    reads.push(getPRComments('/repo', 7, options))
    try {
      const results = await Promise.all(reads)
      expect(results.every((comments) => comments[0]?.id === 10)).toBe(true)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(7)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
