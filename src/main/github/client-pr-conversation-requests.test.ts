import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import type * as GhExecFileModule from '../git/command-runner/gh-exec-file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GhExecFileModule>()),
  ghExecFileAsync: clientMocks.ghExecFileAsyncMock
}))
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

const { ghExecFileAsyncMock, rateLimitGuardMock } = clientMocks

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

describe('PR conversation request reuse', () => {
  beforeEach(() => resetGraphQLRateLimitGuardMocks(clientMocks))
  afterEach(() => vi.restoreAllMocks())

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
      '-H',
      'Accept: application/vnd.github.full+json',
      'repos/acme/widgets/pulls/7/reviews?per_page=100'
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('retains the successful REST source when GraphQL and the other REST source fail', async () => {
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('graphql')) {
        return response(null)
      }
      if (args.some((arg) => arg.includes('/issues/7/comments'))) {
        throw new Error('Issue comments failed')
      }
      return {
        stdout: args.includes('user')
          ? 'me'
          : JSON.stringify([
              {
                id: 11,
                user: null,
                body: 'Recovered review',
                submitted_at: '2026-04-01T00:01:00Z',
                html_url: 'https://example.test/review'
              }
            ])
      }
    })
    await expect(getPRComments('/repo', 7, options)).resolves.toMatchObject([
      { id: 11, body: 'Recovered review' }
    ])
  })

  it('marks only the REST conversation comments the reading account wrote', async () => {
    const restComment = (id: number, login: string) => ({
      id,
      user: { login, avatar_url: '' },
      body: 'LGTM',
      created_at: `2026-04-01T00:0${id}:00Z`,
      html_url: `https://example.test/comment-${id}`
    })
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('graphql')) {
        return response(null)
      }
      if (args.includes('user')) {
        return { stdout: 'Me\n' }
      }
      return {
        stdout: JSON.stringify(
          args.some((arg) => arg.includes('/issues/7/comments'))
            ? [restComment(1, 'alice'), restComment(2, 'me')]
            : []
        )
      }
    })
    const comments = await getPRComments('/repo', 7, { ...options, noCache: true })
    expect(comments.map((c) => [c.author, c.viewerDidAuthor])).toEqual([
      ['alice', undefined],
      ['me', true]
    ])
  })
  it.each([0, 100, 1000])(
    'gets image maps in the existing conversation request (%s bodies)',
    async (n) => {
      const body =
        '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
      const imageComments = Array.from({ length: n }, (_, i) => ({
        ...comment,
        id: `IMAGE_${i}`,
        databaseId: i,
        body,
        bodyHTML:
          '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">',
        path: 'file.ts'
      }))
      const threads = Array.from({ length: n / 100 }, (_, i) => ({
        id: `THREAD_${i}`,
        isResolved: false,
        line: 1,
        startLine: null,
        originalLine: 1,
        originalStartLine: null,
        comments: { nodes: imageComments.slice(i * 100, (i + 1) * 100) }
      }))
      ghExecFileAsyncMock.mockResolvedValueOnce(
        response({
          comments: { nodes: [comment] },
          reviews: { nodes: [] },
          reviewThreads: { nodes: threads }
        })
      )
      const result = await getPRComments('/repo', 7, { ...options, noCache: true })
      // One request owns all selected bodies, independent of their image population.
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(result.filter((c) => c.path === 'file.ts')).toHaveLength(n)
      if (n === 0) {
        return
      }
      expect(result.find((c) => c.id === 0)?.bodyImageUrls).toEqual({
        'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
          'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
      })
      expect(result.find((c) => c.id === 0)?.body).toBe(body)
    }
  )

  it.each([false, true])(
    'holds the existing permit until the paired command settles (reject: %s)',
    async (reject) => {
      let settle!: (result: { stdout: string }) => void
      let fail!: (error: Error) => void
      const pending = new Promise<{ stdout: string }>((resolve, reject) => {
        settle = resolve
        fail = reject
      })
      let started!: () => void
      const commandStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      ghExecFileAsyncMock.mockImplementationOnce(() => {
        started()
        return pending
      })
      const read = getPRComments('/repo', 7, { ...options, noCache: true })
      await commandStarted
      expect(clientMocks.acquireMock).toHaveBeenCalledTimes(1)
      expect(clientMocks.releaseMock).not.toHaveBeenCalled()
      const raw = response({
        comments: { nodes: [comment] },
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] }
      })
      if (reject) {
        fail(Object.assign(new Error('Partial GraphQL response'), raw))
      } else {
        settle(raw)
      }
      const result = await read
      expect(result).toMatchObject([{ body: 'Conversation' }])
      expect(clientMocks.releaseMock).toHaveBeenCalledTimes(1)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(result[0].bodyImageUrls).toBeUndefined()
    }
  )

  it('keeps usable raw fields and siblings when optional HTML errors, without a fallback request', async () => {
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    const html =
      '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
    const partial = response(
      {
        comments: { nodes: [{ ...comment, body, bodyHTML: html }] },
        reviews: { nodes: [] },
        reviewThreads: {
          nodes: [
            {
              id: 'THREAD',
              isResolved: false,
              line: 1,
              startLine: null,
              originalLine: 1,
              originalStartLine: null,
              comments: {
                nodes: [
                  { ...comment, databaseId: 11, body, bodyHTML: html, path: 'file.ts' },
                  { ...comment, databaseId: 12, body, bodyHTML: html, path: 'file.ts' }
                ]
              }
            }
          ]
        }
      },
      [
        { path: ['repository', 'pullRequest', 'comments', 'nodes', 0, 'bodyHTML'] },
        {
          path: [
            'repository',
            'pullRequest',
            'reviewThreads',
            'nodes',
            0,
            'comments',
            'nodes',
            0,
            'bodyHTML'
          ]
        }
      ]
    )
    ghExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('GraphQL error'), partial))
    const result = await getPRComments('/repo', 7, { ...options, noCache: true })
    expect(result.map((c) => c.body)).toEqual([body, body, body])
    expect(result.find((c) => c.id === 10)?.bodyImageUrls).toBeUndefined()
    expect(result.find((c) => c.id === 11)?.bodyImageUrls).toBeUndefined()
    expect(result.find((c) => c.id === 12)?.bodyImageUrls).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
