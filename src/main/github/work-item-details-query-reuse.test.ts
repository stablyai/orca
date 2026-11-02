import { beforeEach, expect, it, vi } from 'vitest'
import type { GitHubApiRepository } from './github-api-repository'
import type { LocalGitExecOptions } from './gh-utils'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  source: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn()
}))
vi.mock('./gh-utils', () => ({
  ghExecFileAsync: mocks.exec,
  acquire: mocks.acquire,
  release: mocks.release,
  ghRepoExecOptions: (context: { repoPath: string; connectionId?: string; wslDistro?: string }) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) },
  githubRepoContext: (repoPath: string, connectionId?: string, options = {}) => ({
    repoPath,
    connectionId,
    ...options
  }),
  classifyGhError: () => ({ type: 'not_found' })
}))
vi.mock('./github-api-repository', () => ({
  resolveIssueGitHubApiRepositorySource: mocks.source,
  githubHostExecOptions: (repository?: GitHubApiRepository) => ({ host: repository?.host })
}))
vi.mock('./client', async () => ({
  ...(await import('./client/fetch/get-work-item')),
  getPRChecks: vi.fn(),
  getPRComments: vi.fn()
}))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))

import { getWorkItemDetails } from './work-item-details'
import { getWorkItemWithRepository } from './client/fetch/get-work-item'

const repository = { owner: 'team', repo: 'widgets', host: 'github.example.com:8443' }
let issue: Record<string, unknown>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.source.mockResolvedValue({ source: repository, fellBack: false })
  issue = {
    number: 5,
    title: 'Closed issue',
    state: 'CLOSED',
    url: 'https://github.example.com:8443/team/widgets/issues/5',
    updatedAt: '2026-10-01T00:00:00Z',
    author: { __typename: 'User', login: 'author', avatarUrl: 'https://avatars.example/author' },
    labels: { nodes: [{ name: 'bug' }, { name: 'urgent' }], pageInfo: { hasNextPage: false } },
    body: 'Description',
    assignees: {
      pageInfo: { hasNextPage: false },
      nodes: [
        { login: 'assigned', name: 'Assigned User', avatarUrl: 'https://avatars.example/assigned' }
      ]
    },
    participants: { nodes: [] },
    comments: {
      nodes: [
        {
          databaseId: 10,
          body: 'Comment',
          createdAt: '2026-10-02T00:00:00Z',
          url: 'https://example/comment',
          author: { login: 'bot', __typename: 'Bot' }
        }
      ]
    }
  }
  mocks.exec.mockImplementation(async (args: string[]) => ({
    stdout: JSON.stringify(
      args.includes('graphql')
        ? { data: { repository: { issue } } }
        : args.some((arg) => arg.includes('/timeline?'))
          ? []
          : {
              number: 5,
              title: 'REST issue',
              state: 'open',
              labels: [{ name: 'all labels' }],
              assignees: [{ login: 'rest-assigned', name: 'REST Assigned User' }]
            }
    )
  }))
})

it.each<{ connectionId?: string; options: LocalGitExecOptions; execution: object }>([
  { options: {}, execution: { cwd: '/repo', host: repository.host } },
  {
    options: { wslDistro: 'Ubuntu' },
    execution: { cwd: '/repo', wslDistro: 'Ubuntu', host: repository.host }
  },
  { connectionId: 'ssh-1', options: {}, execution: { host: repository.host } }
])(
  'loads issue metadata and conversation with one GraphQL read: $execution',
  async ({ connectionId, options, execution }) => {
    const details = await getWorkItemDetails('/repo', 5, 'issue', connectionId, options, 'origin')
    expect(details?.item).toMatchObject({
      title: 'Closed issue',
      state: 'closed',
      labels: ['bug', 'urgent'],
      author: 'author',
      assignees: [{ login: 'assigned', name: 'Assigned User' }]
    })
    expect(details).toMatchObject({
      body: 'Description',
      comments: [{ id: 10, isBot: true }],
      assignees: ['assigned'],
      timelineItems: []
    })
    expect(mocks.source).toHaveBeenCalledWith('/repo', 'origin', connectionId, options)
    expect(mocks.exec).toHaveBeenCalledTimes(2)
    expect(mocks.exec.mock.calls[0][0]).toContain('includeItem=true')
    expect(mocks.exec.mock.calls[1][0]).toContain(
      'repos/team/widgets/issues/5/timeline?per_page=100&page=1'
    )
    expect(
      mocks.exec.mock.calls.every(
        ([, options]) => JSON.stringify(options) === JSON.stringify(execution)
      )
    ).toBe(true)
    expect(mocks.release).toHaveBeenCalledTimes(mocks.acquire.mock.calls.length)
  }
)

it.each(['incomplete labels', 'invalid metadata', 'partial errors'])(
  'retains the REST item fallback for %s',
  async (reason) => {
    if (reason === 'incomplete labels') {
      issue.labels = { nodes: [{ name: 'partial' }], pageInfo: { hasNextPage: true } }
    }
    if (reason === 'invalid metadata') {
      issue.number = 6
    }
    if (reason === 'partial errors') {
      mocks.exec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: { repository: { issue } },
          errors: [{ message: 'Unavailable metadata' }]
        })
      })
    }
    const result = await getWorkItemWithRepository(
      '/repo',
      5,
      'issue',
      undefined,
      {},
      'origin',
      true
    )
    expect(result.item).toMatchObject({ title: 'REST issue', labels: ['all labels'] })
    if (reason === 'incomplete labels') {
      expect(result.issueDetails).toMatchObject({ body: 'Description', timelineItems: [] })
      expect(mocks.exec).toHaveBeenCalledTimes(3)
    } else {
      expect(result.issueDetails).toBeNull()
      expect(mocks.exec).toHaveBeenCalledTimes(2)
    }
    expect(mocks.exec.mock.calls.at(-1)?.[0]).toEqual(['api', 'repos/team/widgets/issues/5'])
  }
)

it('keeps ordinary metadata lookups on their existing REST path', async () => {
  const result = await getWorkItemWithRepository('/repo', 5, 'issue')
  expect(result.item?.title).toBe('REST issue')
  expect(mocks.exec).toHaveBeenCalledTimes(1)
  expect(mocks.exec.mock.calls[0][0]).toEqual(['api', 'repos/team/widgets/issues/5'])
})

it.each([
  { reason: 'missing nodes', nodes: undefined },
  { reason: 'null nodes', nodes: null },
  { reason: 'null entry', nodes: [null] },
  { reason: 'missing login', nodes: [{}] },
  { reason: 'empty login', nodes: [{ login: '' }] }
])('retains conversation and recovers issue assignees for $reason', async ({ nodes }) => {
  issue.assignees = { nodes, pageInfo: { hasNextPage: false } }
  const result = await getWorkItemWithRepository('/repo', 5, 'issue', undefined, {}, 'origin', true)
  expect(result.item).toMatchObject({
    title: 'REST issue',
    assignees: [{ login: 'rest-assigned', name: 'REST Assigned User' }]
  })
  expect(result.issueDetails).toMatchObject({
    body: 'Description',
    comments: [{ id: 10, isBot: true }],
    timelineItems: []
  })
  expect(mocks.exec.mock.calls.map(([args]) => args)).toEqual([
    expect.arrayContaining(['api', 'graphql', 'includeItem=true']),
    expect.arrayContaining(['api', 'repos/team/widgets/issues/5/timeline?per_page=100&page=1']),
    ['api', 'repos/team/widgets/issues/5']
  ])
})

it('does not query an unavailable explicitly selected source', async () => {
  mocks.source.mockResolvedValue({ source: null, fellBack: false })
  expect(
    (await getWorkItemWithRepository('/repo', 5, 'issue', undefined, {}, 'origin', true)).item
  ).toBeNull()
  expect(mocks.exec).not.toHaveBeenCalled()
})

it('retains REST bot login normalization for issue metadata', async () => {
  issue.author = {
    __typename: 'Bot',
    login: 'automation',
    avatarUrl: 'https://avatars.example/bot'
  }
  const result = await getWorkItemWithRepository('/repo', 5, 'issue', undefined, {}, 'origin', true)
  expect(result.item?.author).toBe('automation[bot]')
})
