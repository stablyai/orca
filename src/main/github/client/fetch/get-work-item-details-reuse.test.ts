import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import { beforeEach, expect, it, vi } from 'vitest'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  source: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn()
}))
vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: mocks.exec
}))

vi.mock('../../execution/github-operation-slots', () => ({
  acquire: mocks.acquire,
  release: mocks.release
}))

vi.mock('../../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  ghRepoExecOptions: (context: { repoPath: string; connectionId?: string; wslDistro?: string }) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) },
  githubRepoContext: (repoPath: string, connectionId?: string, options = {}) => ({
    repoPath,
    connectionId,
    ...options
  })
}))

vi.mock('../../api/gh-error-classification', () => ({
  classifyGhError: () => ({ type: 'not_found' })
}))
vi.mock('../../repositories/github-api-repository', () => ({
  resolveIssueGitHubApiRepositorySource: mocks.source
}))

vi.mock('../../repositories/github-repository-host', () => ({
  githubHostExecOptions: (repository?: GitHubApiRepository) => ({ host: repository?.host })
}))
vi.mock('../check/get-pr-checks', async () => ({
  ...(await import('./get-work-item')),
  getPRChecks: vi.fn()
}))

vi.mock('./get-pr-comments', async () => ({
  ...(await import('./get-work-item')),
  getPRComments: vi.fn()
}))
vi.mock('../../api/rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))

import { getWorkItemWithRepository } from './get-work-item'

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
