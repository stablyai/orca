import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalGitExecOptions } from './gh-utils'

const { exec, guard, spend } = vi.hoisted(() => ({ exec: vi.fn(), guard: vi.fn(), spend: vi.fn() }))
vi.mock('./gh-utils', () => ({
  ghExecFileAsync: exec,
  githubRepoContext: (
    repoPath: string,
    connectionId: string | null,
    options: LocalGitExecOptions
  ) => ({ repoPath, connectionId, ...options }),
  ghRepoExecOptions: ({ repoPath, ...options }: { repoPath: string }) => ({
    cwd: repoPath,
    ...options
  })
}))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: guard,
  noteRepositoryRateLimitSpend: spend
}))

import { getPRDetailContext } from './pull-request-detail-context'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const participant = { login: 'reviewer', name: null, avatarUrl: 'https://avatars/reviewer' }
const files = {
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: [{ path: 'src/changed.ts', viewerViewedState: 'VIEWED' }]
}

function response(
  pullRequest: Record<string, unknown> | null = { participants: { nodes: [participant] } },
  viewedPullRequest: Record<string, unknown> | null = { id: 'PR_42', files },
  errors?: Record<string, unknown>[]
) {
  return {
    stdout: JSON.stringify({ data: { repository: { pullRequest, viewedPullRequest } }, errors })
  }
}

function mockReads(reads: ({ stdout: string } | Error | { code: number; stdout: string })[]) {
  exec.mockImplementation(async (args: string[]) => {
    if (args.includes('graphql')) {
      const next = reads.shift()
      if (!next) {
        throw new Error('Unexpected GraphQL read')
      }
      if (next instanceof Error || 'code' in next) {
        throw next
      }
      return next
    }
    throw new Error('Unexpected non-GraphQL read')
  })
}

function graphqlCalls(): string[][] {
  return exec.mock.calls.flatMap(([args]) => (args.includes('graphql') ? [args] : []))
}

beforeEach(() => {
  vi.resetAllMocks()
  guard.mockReturnValue({ blocked: false })
})

describe('PR detail context requests', () => {
  it('reads participants and viewed state in one request', async () => {
    mockReads([response()])
    const result = await getPRDetailContext('/folder-workspace', 42, repository)
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates).toEqual({
      pullRequestId: 'PR_42',
      viewedStates: new Map([['src/changed.ts', 'VIEWED']])
    })
    expect(exec).toHaveBeenCalledTimes(1)
    expect(graphqlCalls()).toHaveLength(1)
    expect(graphqlCalls()[0].join(' ')).not.toMatch(/headRefOid|baseRefOid|\bbody\b/)
    expect(exec.mock.calls[0][1]).toMatchObject({ cwd: '/folder-workspace', host: 'github.com' })
  })

  it('paginates only files after the first page and retains nullable viewer states', async () => {
    mockReads([
      response(undefined, {
        id: 'PR_42',
        files: { ...files, pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } }
      }),
      response(null, {
        id: 'PR_42',
        files: { ...files, nodes: [null, { path: 'src/unknown.ts', viewerViewedState: null }] }
      })
    ])
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.viewedStates?.viewedStates).toEqual(new Map([['src/changed.ts', 'VIEWED']]))
    expect(result.participants).toEqual([participant])
    expect(graphqlCalls()).toHaveLength(2)
    expect(graphqlCalls()[1]).toContain('after=cursor-1')
    expect(graphqlCalls()[1].join(' ')).not.toContain('participants')
  })

  it('accepts successful empty sources without recovery requests', async () => {
    mockReads([
      response({ participants: { nodes: [] } }, { id: 'PR_42', files: { ...files, nodes: [] } })
    ])
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.participants).toEqual([])
    expect(result.viewedStates).toEqual({ pullRequestId: 'PR_42', viewedStates: new Map() })
    expect(graphqlCalls()).toHaveLength(1)
  })

  it.each([
    { path: ['repository', 'pullRequest', 'participants'] },
    { path: ['repository', 'pullRequest'] }
  ])('retains viewed files when an error nulls the participant PR at $path', async ({ path }) => {
    mockReads([{ code: 1, ...response(null, { id: 'PR_42', files }, [{ path }]) }, response()])
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates?.pullRequestId).toBe('PR_42')
    expect(result.viewedStates?.viewedStates.get('src/changed.ts')).toBe('VIEWED')
    expect(graphqlCalls()).toHaveLength(2)
    expect(graphqlCalls()[1].join(' ')).not.toContain('viewerViewedState')
  })

  it('retains participants when the viewed PR alias is nulled', async () => {
    mockReads([
      {
        code: 1,
        ...response(undefined, null, [{ path: ['repository', 'viewedPullRequest', 'id'] }])
      }
    ])
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates).toBeNull()
    expect(graphqlCalls()).toHaveLength(1)
  })

  it('does not publish partially paginated viewed files after a later page fails', async () => {
    mockReads([
      response(undefined, {
        id: 'PR_42',
        files: { ...files, pageInfo: { hasNextPage: true, endCursor: 'next' } }
      }),
      new Error('file page unavailable')
    ])
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates).toBeNull()
    expect(graphqlCalls()).toHaveLength(2)
  })

  it('keeps the three-page file bound without resending participants', async () => {
    mockReads(
      [1, 2, 3].map((page) =>
        response(undefined, {
          id: 'PR_42',
          files: { ...files, pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` } }
        })
      )
    )
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.viewedStates?.pullRequestId).toBe('PR_42')
    expect(graphqlCalls()).toHaveLength(3)
  })

  it('recovers participants after a failed query without retrying unavailable viewed state', async () => {
    mockReads([new Error('Query failed'), response()])
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.participants).toEqual([participant])
    expect(result.viewedStates).toBeNull()
    expect(graphqlCalls()).toHaveLength(2)
  })

  it('loads GraphQL context with no remaining REST quota', async () => {
    guard.mockImplementation((_, bucket: string) => ({ blocked: bucket === 'core' }))
    mockReads([response()])
    const result = await getPRDetailContext('/repo', 42, repository)
    expect(result.viewedStates?.pullRequestId).toBe('PR_42')
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it.each([{ wslDistro: 'Ubuntu' }, {}])('keeps host and execution routing %j', async (options) => {
    mockReads([response()])
    await getPRDetailContext(
      '/remote/repo',
      42,
      { ...repository, host: 'ghe.example.com' },
      'ssh-1',
      options
    )
    for (const [, execution] of exec.mock.calls) {
      expect(execution).toMatchObject({
        cwd: '/remote/repo',
        connectionId: 'ssh-1',
        host: 'ghe.example.com',
        ...options
      })
    }
  })
})
