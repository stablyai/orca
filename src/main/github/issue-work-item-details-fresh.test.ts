import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ exec: vi.fn(), guard: vi.fn() }))
vi.mock('./gh-utils', () => ({
  ghExecFileAsync: mocks.exec,
  ghRepoExecOptions: () => ({}),
  githubRepoContext: () => ({})
}))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: mocks.guard,
  noteRepositoryRateLimitSpend: vi.fn()
}))
import { getIssueBodyAndComments, getIssueDetailsViaGraphQL } from './issue-work-item-details'
const repository = { owner: 'acme', repo: 'widgets' }

describe('explicit task refresh conversation reads', () => {
  beforeEach(() => {
    mocks.exec.mockReset()
    mocks.guard.mockReset()
    mocks.guard.mockReturnValue({ blocked: false })
  })
  it('bypasses body, comments and timeline caches and reads every comments page', async () => {
    mocks.exec.mockImplementation(async (args: string[]) => ({
      stdout: args.some((arg) => arg.includes('/comments?'))
        ? JSON.stringify([
            [{ id: 1, user: null, body: 'first', created_at: '', html_url: '' }],
            [{ id: 2, user: null, body: 'second', created_at: '', html_url: '' }]
          ])
        : args.some((arg) => arg.includes('/timeline?'))
          ? ''
          : JSON.stringify({ body: 'current', assignees: [] })
    }))
    const result = await getIssueBodyAndComments('/repo', 42, repository, null, {}, true)
    expect(result.body).toBe('current')
    expect(result.comments.map((comment) => comment.body)).toEqual(['first', 'second'])
    expect(mocks.exec).toHaveBeenCalledTimes(3)
    for (const [args] of mocks.exec.mock.calls) {
      expect(args).not.toContain('--cache')
    }
    expect(
      mocks.exec.mock.calls.find(([args]) =>
        args.some((arg: string) => arg.includes('/comments?'))
      )?.[0]
    ).toEqual(expect.arrayContaining(['--paginate', '--slurp']))
  })
  it.each(['body', 'comments', 'timeline'] as const)(
    'fails the whole explicit read if required %s fails',
    async (field) => {
      mocks.exec.mockImplementation(async (args: string[]) => {
        const route = args.find((arg) => arg.startsWith('repos/')) ?? ''
        const actual = route.includes('/comments?')
          ? 'comments'
          : route.includes('/timeline?')
            ? 'timeline'
            : 'body'
        if (actual === field) {
          throw new Error('request failed')
        }
        return {
          stdout:
            actual === 'body'
              ? JSON.stringify({ body: 'current' })
              : actual === 'comments'
                ? '[]'
                : ''
        }
      })
      await expect(
        getIssueBodyAndComments('/repo', 42, repository, null, {}, true)
      ).rejects.toThrow('request failed')
    }
  )
  it('retains ordinary fallback behavior but does not report an explicit rate-limited read as success', async () => {
    mocks.guard.mockReturnValue({ blocked: true })
    expect(await getIssueBodyAndComments('/repo', 42, repository)).toEqual({
      body: '',
      comments: [],
      assignees: [],
      timelineItems: []
    })
    await expect(getIssueBodyAndComments('/repo', 42, repository, null, {}, true)).rejects.toThrow()
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('falls back from incomplete GraphQL conversations and malformed timelines', async () => {
    mocks.exec.mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: { body: 'new', comments: { nodes: [], pageInfo: { hasNextPage: true } } }
          }
        }
      })
    })
    expect(
      await getIssueDetailsViaGraphQL('/repo', 42, repository, null, {}, false, true)
    ).toBeNull()
    mocks.exec.mockImplementation(async (args: string[]) => ({
      stdout: args.some((arg) => arg.includes('/timeline?'))
        ? 'not-json'
        : args.some((arg) => arg.includes('/comments?'))
          ? '[]'
          : '{"body":"new"}'
    }))
    await expect(getIssueBodyAndComments('/repo', 42, repository, null, {}, true)).rejects.toThrow()
  })
})
