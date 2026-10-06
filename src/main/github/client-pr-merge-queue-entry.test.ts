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

import { getPRForBranch } from './client'
import {
  fetchPullRequestMergeQueueEntry,
  parsePullRequestMergeQueueEntryResponse
} from './client/detect/pull-request-merge-queue-entry'
import { resetPRForBranchMocks } from './client-test-harness'

const { ghExecFileAsyncMock, getOwnerRepoMock, rateLimitGuardMock } = clientMocks

function graphqlPullRequest(pullRequest: unknown): string {
  return JSON.stringify({ data: { repository: { pullRequest } } })
}

function prView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: 'PR',
    state: 'OPEN',
    url: 'https://github.com/stablyai/orca/pull/7',
    statusCheckRollup: [],
    updatedAt: '2026-04-01T00:00:00Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    baseRefName: 'main',
    baseRefOid: 'base-oid',
    headRefOid: 'head-oid',
    ...overrides
  }
}

function isMergeQueueEntryQuery(args: string[]): boolean {
  return args.includes('graphql') && args.some((arg) => arg.includes('isInMergeQueue'))
}

function mockGitHub(options: { view: Record<string, unknown>; mergeQueue: unknown }): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (isMergeQueueEntryQuery(args)) {
      return { stdout: graphqlPullRequest(options.mergeQueue) }
    }
    if (args.includes('graphql')) {
      return { stdout: JSON.stringify({ data: { repository: { mergeQueue: { id: 'MQ_kw' } } } }) }
    }
    if (args[0] === 'api') {
      return { stdout: JSON.stringify({ stack: null }) }
    }
    return { stdout: JSON.stringify(options.view) }
  })
}

describe('parsePullRequestMergeQueueEntryResponse', () => {
  it('reads a queued entry with its position and state', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(
        graphqlPullRequest({
          isInMergeQueue: true,
          mergeQueueEntry: { position: 3, state: 'AWAITING_CHECKS' }
        })
      )
    ).toEqual({ position: 3, state: 'AWAITING_CHECKS' })
  })

  it('reports a PR outside the queue as null', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(
        graphqlPullRequest({ isInMergeQueue: false, mergeQueueEntry: null })
      )
    ).toBeNull()
  })

  it('keeps a queued entry readable when GitHub sends an unknown state or no entry', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(
        graphqlPullRequest({
          isInMergeQueue: true,
          mergeQueueEntry: { position: 0, state: 'SOMETHING_NEW' }
        })
      )
    ).toEqual({ position: null, state: null })
    expect(
      parsePullRequestMergeQueueEntryResponse(
        graphqlPullRequest({ isInMergeQueue: true, mergeQueueEntry: null })
      )
    ).toEqual({ position: null, state: null })
  })

  it('treats a GraphQL error payload as unknown rather than not queued', () => {
    expect(
      parsePullRequestMergeQueueEntryResponse(
        JSON.stringify({ data: null, errors: [{ message: 'Field does not exist' }] })
      )
    ).toBeUndefined()
  })
})

describe('fetchPullRequestMergeQueueEntry', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('queries the PR on its own GitHub host', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: graphqlPullRequest({
        isInMergeQueue: true,
        mergeQueueEntry: { position: 1, state: 'QUEUED' }
      })
    })
    const repository = { owner: 'acme', repo: 'widgets', host: 'github.acme-corp.com' }

    await expect(fetchPullRequestMergeQueueEntry(repository, 9, { cwd: '/repo' })).resolves.toEqual(
      { position: 1, state: 'QUEUED' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['api', 'graphql', '-f', 'owner=acme', '-f', 'repo=widgets']),
      expect.objectContaining({ cwd: '/repo', host: 'github.acme-corp.com' })
    )
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['-F', 'number=9'])
    )
  })

  it('skips gh entirely while the GraphQL budget is blocked', async () => {
    rateLimitGuardMock.mockReturnValue({ blocked: true, remaining: 0, limit: 5000, resetAt: 1 })

    await expect(
      fetchPullRequestMergeQueueEntry({ owner: 'acme', repo: 'widgets' }, 9, {})
    ).resolves.toBeUndefined()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns unknown when gh fails', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('network is down'))

    await expect(
      fetchPullRequestMergeQueueEntry({ owner: 'acme', repo: 'widgets' }, 9, {})
    ).resolves.toBeUndefined()
  })
})

describe('getPRForBranch merge queue entry', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
  })

  it('adds the queue entry to an open PR on a merge-queue branch', async () => {
    mockGitHub({
      view: prView(),
      mergeQueue: { isInMergeQueue: true, mergeQueueEntry: { position: 2, state: 'QUEUED' } }
    })

    await expect(getPRForBranch('/repo-root', 'feature/test', 7)).resolves.toMatchObject({
      state: 'open',
      mergeQueueRequired: true,
      mergeQueueEntry: { position: 2, state: 'QUEUED' }
    })
  })

  it('reports a checked open PR that is not queued as null', async () => {
    mockGitHub({ view: prView(), mergeQueue: { isInMergeQueue: false, mergeQueueEntry: null } })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 7)

    expect(pr?.mergeQueueEntry).toBeNull()
  })

  it('does not query the queue for merged or draft PRs', async () => {
    mockGitHub({ view: prView({ state: 'MERGED' }), mergeQueue: { isInMergeQueue: true } })
    const merged = await getPRForBranch('/repo-root', 'feature/test', 7)
    mockGitHub({ view: prView({ number: 8, isDraft: true }), mergeQueue: { isInMergeQueue: true } })
    const draft = await getPRForBranch('/repo-root', 'feature/draft', 8)

    expect(merged).not.toHaveProperty('mergeQueueEntry')
    expect(draft).not.toHaveProperty('mergeQueueEntry')
    expect(
      ghExecFileAsyncMock.mock.calls.filter(([args]) => isMergeQueueEntryQuery(args))
    ).toHaveLength(0)
  })

  it('omits the field when the queue query fails', async () => {
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (isMergeQueueEntryQuery(args)) {
        throw new Error('HTTP 502')
      }
      if (args.includes('graphql')) {
        return { stdout: JSON.stringify({ data: { repository: { mergeQueue: { id: 'MQ' } } } }) }
      }
      return { stdout: JSON.stringify(args[0] === 'api' ? { stack: null } : prView()) }
    })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 7)

    expect(pr).toMatchObject({ state: 'open', mergeQueueRequired: true })
    expect(pr).not.toHaveProperty('mergeQueueEntry')
  })
})
