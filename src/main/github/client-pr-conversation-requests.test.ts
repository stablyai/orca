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
  return {
    stdout: JSON.stringify({ data: { repository: { pullRequest: pr } }, errors }, (_key, value) =>
      value && typeof value === 'object' && Array.isArray(value.nodes)
        ? { pageInfo: { hasNextPage: false, endCursor: null }, ...value }
        : value
    )
  }
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
      .mockResolvedValueOnce({ stdout: 'me' })
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
    expect(ghExecFileAsyncMock.mock.calls[2][0]).toEqual([
      'api',
      '-H',
      'Accept: application/vnd.github.full+json',
      'repos/acme/widgets/pulls/7/reviews?per_page=100'
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
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
  it('pages independent sources and nested replies without rereading completed sources', async () => {
    const thread = {
      id: 'T1',
      isResolved: true,
      line: 4,
      startLine: null,
      originalLine: 4,
      originalStartLine: null,
      rootHunk: { nodes: [{ diffHunk: '@@ -1 +1 @@\n-old\n+new' }] },
      comments: {
        nodes: [{ ...comment, id: 'ROOT', databaseId: 11, path: 'a.ts' }],
        pageInfo: { hasNextPage: true, endCursor: 'reply-1' }
      }
    }
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('threadId=T1')) {
        return {
          stdout: JSON.stringify({
            data: {
              node: {
                ...thread,
                comments: {
                  nodes: [{ ...comment, id: 'REPLY', databaseId: 12, body: 'Reply', path: 'a.ts' }],
                  pageInfo: { hasNextPage: false, endCursor: null }
                }
              }
            }
          })
        }
      }
      if (args.includes('cursor=comment-1')) {
        return response({
          comments: { nodes: [{ ...comment, id: 'IC_13', databaseId: 13, body: 'Newest' }] }
        })
      }
      return response({
        comments: { nodes: [comment], pageInfo: { hasNextPage: true, endCursor: 'comment-1' } },
        reviews: { nodes: [] },
        reviewThreads: { nodes: [thread] }
      })
    })
    const result = await getPRComments('/repo', 7, { ...options, noCache: true })
    expect(result.map((c) => c.id)).toEqual([10, 13, 11, 12])
    expect(result.find((c) => c.id === 11)).toMatchObject({
      threadId: 'T1',
      isResolved: true,
      path: 'a.ts',
      line: 4,
      diffHunk: '-old\n+new'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
    const continuation = ghExecFileAsyncMock.mock.calls[1][0].join(' ')
    expect(continuation).not.toContain('reviewThreads(')
    expect(continuation).not.toContain('reviews(')
  })

  it.each(['failure', 'repeated cursor'])(
    'rejects an incomplete conversation after %s',
    async (mode) => {
      const first = response({
        comments: { nodes: [comment], pageInfo: { hasNextPage: true, endCursor: 'same' } },
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] }
      })
      ghExecFileAsyncMock.mockResolvedValueOnce(first)
      if (mode === 'failure') {
        ghExecFileAsyncMock.mockRejectedValueOnce(new Error('offline'))
      } else {
        ghExecFileAsyncMock.mockResolvedValueOnce(first)
      }
      await expect(getPRComments('/repo', 7, { ...options, noCache: true })).rejects.toThrow(
        /pagination|cursor/
      )
    }
  )

  it.each([10, 100])(
    'stops sibling admission after a hard REST failure with %s remaining pages',
    async (remaining) => {
      let releaseSibling!: (value: { stdout: string }) => void
      let rejectPage!: (error: Error) => void
      const sibling = new Promise<{ stdout: string }>((resolve) => {
        releaseSibling = resolve
      })
      const failed = new Promise<{ stdout: string }>((_resolve, reject) => {
        rejectPage = reject
      })
      const fullPage = (page: number) =>
        JSON.stringify(
          Array.from({ length: 100 }, (_, i) => ({
            id: (page - 1) * 100 + i,
            body: 'Review',
            user: null,
            submitted_at: '2026-04-01T00:00:00Z',
            created_at: '2026-04-01T00:00:00Z',
            html_url: 'https://example.test/review'
          }))
        )
      ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
        if (args.includes('graphql')) {
          return response(null)
        }
        if (args.includes('user')) {
          return { stdout: 'me' }
        }
        const endpoint = args.at(-1) ?? ''
        const page = Number(new URL(endpoint, 'https://github.com').searchParams.get('page') ?? 1)
        if (page === 2) {
          return endpoint.includes('/issues/') ? failed : sibling
        }
        return { stdout: page <= remaining + 2 ? fullPage(page) : '[]' }
      })
      let settled = false
      const read = getPRComments('/repo', 7, { ...options, noCache: true })
      const outcome = read.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await vi.waitFor(() =>
        expect(
          ghExecFileAsyncMock.mock.calls.filter(([args]) => args.at(-1)?.includes('&page=2'))
        ).toHaveLength(2)
      )
      rejectPage(new Error('offline'))
      await new Promise((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(clientMocks.releaseMock).not.toHaveBeenCalled()
      releaseSibling({ stdout: fullPage(2) })
      await expect(read).rejects.toThrow('pagination')
      await outcome
      expect(clientMocks.releaseMock).toHaveBeenCalledTimes(1)
      expect(
        ghExecFileAsyncMock.mock.calls.filter(([args]) => args.at(-1)?.includes('page=3'))
      ).toHaveLength(0)
    }
  )

  it('pages raw REST review rows even when the first 100 bodies are hidden', async () => {
    const review = (id: number, body: string) => ({
      id,
      body,
      user: null,
      submitted_at: '2026-04-01T00:00:00Z',
      html_url: 'https://example.test/review'
    })
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('graphql')) {
        return response({ comments: { nodes: [] }, reviews: null, reviewThreads: { nodes: [] } })
      }
      if (args.includes('user')) {
        return { stdout: 'me' }
      }
      return {
        stdout: JSON.stringify(
          args.at(-1)?.includes('&page=2')
            ? [review(101, 'Latest summary')]
            : Array.from({ length: 100 }, (_, i) => review(i, '<!-- hidden -->'))
        )
      }
    })
    await expect(getPRComments('/repo', 7, { ...options, noCache: true })).resolves.toMatchObject([
      { id: 101, body: 'Latest summary' }
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(4)
  })
  it.each([100, 1000])(
    'walks %s independent conversation rows and replies with output-derived page counts',
    async (count) => {
      const connection = (nodes: unknown[], page: number) => ({
        nodes,
        pageInfo: {
          hasNextPage: page * 100 < count,
          endCursor: page * 100 < count ? String(page + 1) : null
        }
      })
      const comments = (source: string, page: number) =>
        Array.from({ length: 100 }, (_, i) => ({
          ...comment,
          id: `${source}-${(page - 1) * 100 + i}`,
          databaseId:
            (source === 'comments' ? 0 : source === 'reviews' ? 10000 : 20000) +
            (page - 1) * 100 +
            i,
          ...(source === 'reply' ? { path: 'a.ts' } : {})
        }))
      const thread = (index: number) => ({
        id: `T${index}`,
        isResolved: false,
        line: 4,
        startLine: null,
        originalLine: 4,
        originalStartLine: null,
        comments:
          index === 0
            ? connection(comments('reply', 1), 1)
            : {
                nodes: [{ ...comment, id: `C${index}`, databaseId: 30000 + index, path: 'a.ts' }],
                pageInfo: { hasNextPage: false, endCursor: null }
              }
      })
      const threads = (page: number) =>
        connection(
          Array.from({ length: 100 }, (_, i) => thread((page - 1) * 100 + i)),
          page
        )
      ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
        const page = Number(args.find((arg) => arg.startsWith('cursor='))?.slice(7) ?? 1)
        if (args.includes('threadId=T0')) {
          return {
            stdout: JSON.stringify({
              data: { node: { ...thread(0), comments: connection(comments('reply', page), page) } }
            })
          }
        }
        if (page === 1) {
          return response({
            comments: connection(comments('comments', 1), 1),
            reviews: connection(comments('reviews', 1), 1),
            reviewThreads: threads(1)
          })
        }
        const query = args.find((arg) => arg.startsWith('query=')) ?? ''
        return response(
          query.includes('reviewThreads(first:')
            ? { reviewThreads: threads(page) }
            : query.includes('reviews(first:')
              ? { reviews: connection(comments('reviews', page), page) }
              : { comments: connection(comments('comments', page), page) }
        )
      })
      const result = await getPRComments('/repo', 7, { ...options, noCache: true })
      expect(result).toHaveLength(count * 4 - 1)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1 + 4 * (count / 100 - 1))
    }
  )
})
