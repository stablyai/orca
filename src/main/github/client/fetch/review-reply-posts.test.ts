import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  gh: vi.fn<(args: string[]) => Promise<{ stdout: string; stderr: string }>>()
}))

vi.mock('../../gh-utils', () => ({
  ghExecFileAsync: mocks.gh,
  acquire: async () => {},
  release: () => {}
}))
vi.mock('../../github-api-repository', () => ({
  resolveGitHubRepoExecution: async () => ({
    ownerRepo: { owner: 'acme', repo: 'app' },
    ghOptions: {}
  })
}))

import { getReviewReplyPosts } from './review-reply-posts'

const SINCE = '2026-10-03T10:00:00.000Z'

function answer(graphql: unknown, rest: unknown = []) {
  mocks.gh.mockImplementation(async (args) => ({
    stdout: JSON.stringify(args[1] === 'graphql' ? graphql : rest),
    stderr: ''
  }))
}

function read(threadIds: string[] = ['PRRT_a', 'PRRT_b']) {
  return getReviewReplyPosts('/repos/app', { prNumber: 42, threadIds, since: SINCE })
}

describe('what a review reply may already have posted', () => {
  beforeEach(() => {
    mocks.gh.mockReset()
  })

  it("reads each reply's thread newest first, the conversation since, and the account", async () => {
    answer(
      {
        data: {
          viewer: { login: 'me' },
          t0: {
            comments: { nodes: [{ author: { login: 'me' }, body: 'Fixing', createdAt: SINCE }] }
          },
          t1: { comments: { nodes: [] } }
        }
      },
      [{ user: { login: 'me' }, body: 'Fixing all', created_at: SINCE }]
    )

    await expect(read()).resolves.toEqual({
      viewerLogin: 'me',
      threads: {
        PRRT_a: [{ author: 'me', body: 'Fixing', createdAt: SINCE }],
        PRRT_b: []
      },
      conversation: [{ author: 'me', body: 'Fixing all', createdAt: SINCE }]
    })
    const [graphqlArgs, restArgs] = mocks.gh.mock.calls.map(([args]) => args)
    expect(graphqlArgs?.join(' ')).toContain('t0: node(id: "PRRT_a")')
    expect(graphqlArgs?.join(' ')).toContain('comments(last: 100)')
    expect(restArgs?.[1]).toBe(
      `repos/acme/app/issues/42/comments?since=${encodeURIComponent(SINCE)}&per_page=100`
    )
  })

  it('never puts something that is not a node id into the query', async () => {
    answer({ data: { viewer: { login: 'me' } } })

    await expect(read(['"){ evil }'])).resolves.toMatchObject({ threads: {} })
    expect(mocks.gh.mock.calls[0]?.[0].join(' ')).not.toContain('evil')
  })

  it('throws when GitHub refuses either read, instead of reading as nothing posted', async () => {
    answer({
      data: { viewer: { login: 'me' } },
      errors: [{ message: 'Could not resolve to a node' }]
    })
    await expect(read()).rejects.toThrow('GitHub refused the thread read')

    mocks.gh.mockRejectedValue(new Error('HTTP 502'))
    await expect(read()).rejects.toThrow('HTTP 502')

    answer({ data: { viewer: { login: 'me' } } }, { message: 'Not Found' })
    await expect(read()).rejects.toThrow('conversation read')
  })
})
