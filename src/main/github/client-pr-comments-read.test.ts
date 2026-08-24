import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
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

import { getPRComments } from './client'
import { resetGraphQLRateLimitGuardMocks } from './client-test-harness'

const { ghExecFileAsyncMock, getOwnerRepoMock, noteRateLimitSpendMock } = clientMocks

type ThreadCommentOverrides = Record<string, unknown>

function threadComment(id: number, overrides?: ThreadCommentOverrides): Record<string, unknown> {
  return {
    id: `PRRC_${id}`,
    databaseId: id,
    state: 'SUBMITTED',
    diffHunk: `@@ -1,3 +1,3 @@\n context\n+anchor line ${id}`,
    author: { __typename: 'User', login: 'alice', avatarUrl: 'https://avatar' },
    body: `body ${id}`,
    createdAt: '2026-04-01T00:00:00Z',
    url: `https://github.com/acme/widgets/pull/7#discussion_r${id}`,
    path: 'src/a.ts',
    ...overrides
  }
}

function graphQLPayload(pullRequest: Record<string, unknown>): { stdout: string } {
  return { stdout: JSON.stringify({ data: { repository: { pullRequest } } }) }
}

describe('getPRComments extended read path', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
  })

  it('maps pending state, anchor hunk, server outdated flag, and diff side', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphQLPayload({
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'T1',
                isResolved: false,
                isOutdated: false,
                diffSide: 'LEFT',
                line: 5,
                startLine: null,
                originalLine: null,
                originalStartLine: null,
                comments: {
                  nodes: [threadComment(1, { state: 'PENDING' })]
                }
              },
              {
                id: 'T2',
                isResolved: true,
                isOutdated: true,
                diffSide: 'RIGHT',
                // Why: server can report outdated even when a line survives; server flag must win.
                line: 9,
                startLine: null,
                originalLine: null,
                originalStartLine: null,
                comments: { nodes: [threadComment(2)] }
              }
            ]
          },
          comments: { nodes: [] },
          reviews: { nodes: [] }
        })
      )
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const comments = await getPRComments('/repo-root', 7)
    const pending = comments.find((c) => c.id === 1)
    expect(pending).toMatchObject({
      isPending: true,
      diffSide: 'LEFT',
      isOutdated: false,
      diffHunk: '@@ -1,3 +1,3 @@\n context\n+anchor line 1'
    })
    const outdated = comments.find((c) => c.id === 2)
    expect(outdated).toMatchObject({ isOutdated: true, isPending: undefined })
  })

  it('keeps REST sources when the review-threads payload is malformed', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'gh: warning — not json' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 9,
            user: { login: 'carol', avatar_url: '' },
            body: 'conversation survives',
            created_at: '2026-04-01T00:00:00Z',
            html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-9'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    const comments = await getPRComments('/repo-root', 7)
    expect(comments.map((c) => c.id)).toEqual([9])
  })

  it('follows reviewThreads pagination and spends graphql budget per page', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphQLPayload({
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
            nodes: [
              {
                id: 'T1',
                isResolved: false,
                isOutdated: false,
                diffSide: 'RIGHT',
                line: 5,
                startLine: null,
                originalLine: null,
                originalStartLine: null,
                comments: { nodes: [threadComment(1)] }
              }
            ]
          },
          comments: { nodes: [] },
          reviews: { nodes: [] }
        })
      )
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce(
        graphQLPayload({
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'T2',
                isResolved: false,
                isOutdated: false,
                diffSide: 'RIGHT',
                line: 12,
                startLine: null,
                originalLine: null,
                originalStartLine: null,
                comments: { nodes: [threadComment(2)] }
              }
            ]
          }
        })
      )

    const comments = await getPRComments('/repo-root', 7)
    expect(comments.map((c) => c.threadId).sort()).toEqual(['T1', 'T2'])
    const pageCall = ghExecFileAsyncMock.mock.calls[3]?.[0] as string[]
    expect(pageCall).toEqual(expect.arrayContaining(['after=CURSOR_1']))
    expect(noteRateLimitSpendMock.mock.calls.filter((call) => call[0] === 'graphql')).toHaveLength(
      2
    )
  })
})
