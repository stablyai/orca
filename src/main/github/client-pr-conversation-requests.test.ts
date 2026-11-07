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
import { enrichGitHubBodyImages } from './body-image-enrichment'
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
  it.each([100, 1000])(
    'enriches only candidate bodies in bounded batches (%s bodies)',
    async (n) => {
      const body =
        '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
      const imageComments = Array.from({ length: n }, (_, i) => ({
        ...comment,
        id: `IMAGE_${i}`,
        databaseId: i,
        body,
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
      const selected: string[] = []
      ghExecFileAsyncMock.mockImplementation(async (_args, opts) => {
        const ids: string[] = JSON.parse(opts.stdin).variables.ids
        expect(ids.length).toBeLessThanOrEqual(100)
        selected.push(...ids)
        return {
          stdout: JSON.stringify({
            data: {
              nodes: ids.map((id) => ({
                id,
                body,
                bodyHTML:
                  '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
              }))
            }
          })
        }
      })
      const result = await getPRComments('/repo', 7, { ...options, noCache: true })
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1 + n / 100)
      expect(selected).toEqual(imageComments.map((c) => c.id))
      expect(result.filter((c) => c.path === 'file.ts')).toHaveLength(n)
      expect(result.find((c) => c.id === 0)?.bodyImageUrls).toEqual({
        'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
          'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
      })
      expect(result.find((c) => c.id === 0)?.body).toBe(body)
    }
  )

  it('retains raw review threads when optional HTML overflows or fails', async () => {
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        response({
          comments: { nodes: [] },
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
                comments: { nodes: [{ ...comment, body, path: 'file.ts' }] }
              }
            ]
          }
        })
      )
      .mockRejectedValueOnce(Object.assign(new Error('output limit'), { stdout: '{' }))
    const result = await getPRComments('/repo', 7, { ...options, noCache: true })
    expect(result).toMatchObject([
      {
        body: '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)',
        path: 'file.ts',
        threadId: 'THREAD'
      }
    ])
    expect(result[0].bodyImageUrls).toBeUndefined()
  })
  it('deduplicates sparse IDs and accepts only matching bodies from partial enrichment', async () => {
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    const a: { body: string; bodyImageUrls?: Record<string, string> } = { body }
    const duplicate = { body }
    const edited: { body: string; bodyImageUrls?: Record<string, string> } = { body }
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('partial'), {
        stdout: JSON.stringify({
          data: {
            nodes: [
              {
                id: 'A',
                body,
                bodyHTML:
                  '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
              },
              {
                id: 'B',
                body: 'Changed in GitHub',
                bodyHTML:
                  '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
              },
              null
            ]
          },
          errors: [{ message: 'one unavailable' }]
        })
      })
    )
    await enrichGitHubBodyImages(
      [
        { nodeId: 'A', target: a },
        { nodeId: 'A', target: duplicate },
        { nodeId: 'B', target: edited },
        { nodeId: 'PLAIN', target: { body: 'Plain text' } },
        { target: { body } }
      ],
      repository,
      {}
    )
    expect(JSON.parse(ghExecFileAsyncMock.mock.calls[0][1].stdin).variables.ids).toEqual(['A', 'B'])
    expect(a.bodyImageUrls).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
    expect(duplicate).toEqual(a)
    expect(edited).toEqual({
      body: '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    })
  })
})
