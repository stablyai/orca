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
    for (const [args] of mocks.exec.mock.calls.filter(([args]) =>
      args.some((arg: string) => arg.startsWith('repos/'))
    )) {
      expect(args).not.toContain('--cache')
    }
    expect(
      mocks.exec.mock.calls.find(([args]) =>
        args.some((arg: string) => arg.includes('/comments?'))
      )?.[0]
    ).toEqual(expect.arrayContaining(['--paginate', '--slurp']))
  })
  it('marks only the comments the reading gh account wrote', async () => {
    const comment = (id: number, login: string) => ({
      id,
      user: { login, avatar_url: '' },
      body: 'LGTM',
      created_at: '',
      html_url: ''
    })
    mocks.exec.mockImplementation(async (args: string[]) => ({
      stdout: args.includes('user')
        ? 'Me\n'
        : args.some((arg) => arg.includes('/comments?'))
          ? JSON.stringify([[comment(1, 'alice')], [comment(2, 'me')]])
          : args.some((arg) => arg.includes('/timeline?'))
            ? ''
            : JSON.stringify({ body: 'current' })
    }))
    const result = await getIssueBodyAndComments('/repo', 42, repository, null, {}, true)
    expect(result.comments.map((c) => [c.author, c.viewerDidAuthor])).toEqual([
      ['alice', undefined],
      ['me', true]
    ])
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

it('pairs issue and comment image sources through collapsed and REST detail reads', async () => {
  mocks.exec.mockReset()
  mocks.guard.mockReturnValue({ blocked: false })
  const body =
    '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
  const html =
    '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
  mocks.exec.mockImplementation(async (args: string[]) => ({
    stdout: JSON.stringify(
      args.includes('graphql')
        ? {
            data: {
              repository: {
                issue: {
                  body,
                  bodyHTML: html,
                  comments: { nodes: [{ databaseId: 1, body, bodyHTML: html }] }
                }
              }
            }
          }
        : args.some((arg) => arg.includes('/timeline?'))
          ? []
          : args.some((arg) => arg.includes('/comments?'))
            ? [{ id: 1, user: null, body, body_html: html }]
            : { body, body_html: html }
    )
  }))
  const collapsed = await getIssueDetailsViaGraphQL('/repo', 42, repository)
  const rest = await getIssueBodyAndComments('/repo', 42, repository)
  for (const details of [collapsed!, rest]) {
    expect(details.body).toBe(body)
    expect(details.bodyImageUrls).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
    expect(details.comments[0].bodyImageUrls).toEqual(details.bodyImageUrls)
  }
  for (const [args] of mocks.exec.mock.calls.filter(([args]) =>
    args.some((arg: string) => /\/issues\/42(?:$|\/comments)/.test(arg))
  )) {
    expect(args).toContain('Accept: application/vnd.github.full+json')
    expect(args).not.toContain('--cache')
  }
})

it.each(['optional HTML', 'required body', 'pathless', 'rejection without errors'] as const)(
  'admits rejected issue stdout only for available optional HTML failures (%s)',
  async (input) => {
    mocks.exec.mockReset()
    mocks.guard.mockReturnValue({ blocked: false })
    const body =
      '![shot](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    const html =
      '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
    mocks.exec.mockRejectedValueOnce(
      Object.assign(new Error('GraphQL failed'), {
        stdout: JSON.stringify({
          data: {
            repository: {
              issue: {
                body,
                bodyHTML: html,
                comments: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ databaseId: 1, body, bodyHTML: html }]
                }
              }
            }
          },
          errors:
            input === 'rejection without errors'
              ? undefined
              : [
                  {
                    path:
                      input === 'pathless'
                        ? undefined
                        : ['repository', 'issue', input === 'required body' ? 'body' : 'bodyHTML']
                  }
                ]
        })
      })
    )
    mocks.exec.mockResolvedValueOnce({ stdout: '[]' })
    const result = await getIssueDetailsViaGraphQL('/repo', 42, repository, null, {}, false, true)
    if (input !== 'optional HTML') {
      expect(result).toBeNull()
      expect(mocks.exec).toHaveBeenCalledTimes(1)
      return
    }
    expect(result?.body).toBe(body)
    expect(result?.bodyImageUrls).toBeUndefined()
    expect(result?.comments[0].bodyImageUrls).toEqual({
      'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
        'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
    })
    expect(mocks.exec).toHaveBeenCalledTimes(2)
  }
)
