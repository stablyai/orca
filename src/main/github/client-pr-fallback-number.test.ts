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

import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { resetPRForBranchMocks, mockPRLookupRoutes } from './client-test-harness'

const { ghExecFileAsyncMock, resolvePRRepositoryCandidatesMock } = clientMocks

const unexpectedRequests: string[][] = []
function metadataCalls() {
  return ghExecFileAsyncMock.mock.calls.filter(
    ([args]) =>
      args[0] === 'pr' ||
      (args[0] === 'api' && args[1]?.startsWith('repos/') && args[1].includes('/pulls?'))
  )
}

function mockLookupRoutes(
  routes: Parameters<typeof mockPRLookupRoutes>[1],
  unavailableChecks = false
): void {
  mockPRLookupRoutes(clientMocks, routes, unavailableChecks, unexpectedRequests)
}

describe('getPRForBranch', () => {
  afterEach(() => {
    expect(unexpectedRequests).toEqual([])
  })
  beforeEach(() => {
    unexpectedRequests.length = 0
    resetPRForBranchMocks(clientMocks)
  })

  it('lets fallback PR number recovery win after fallback branch queries throw', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    mockLookupRoutes([
      [
        'list:stablyai/orca:feature/test',
        async () => {
          throw new Error('HTTP 429: API rate limit exceeded')
        }
      ],
      [
        'repos/stablyai/orca/pulls?head=stablyai%3Afeature%2Ftest&state=all&per_page=10',
        async () => {
          throw new Error('HTTP 502: Bad Gateway')
        }
      ],
      [
        'view:stablyai/orca:42',
        async () => ({
          stdout: JSON.stringify({
            number: 42,
            title: 'Fallback number recovered PR',
            state: 'OPEN',
            url: 'https://github.com/stablyai/orca/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          })
        })
      ]
    ])

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test', null, null, 42)

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 42,
        title: 'Fallback number recovered PR'
      }
    })
    expect(metadataCalls()[2]).toEqual([
      [
        'pr',
        'view',
        '42',
        '--repo',
        'stablyai/orca',
        '--json',
        'number,title,state,url,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid,headRepositoryOwner,headRepository,isCrossRepository'
      ],
      { cwd: '/repo-root' }
    ])
  })

  it('keeps a pending fallback branch error when a later candidate cleanly misses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: null
    })
    mockLookupRoutes([
      [
        'list:stablyai/orca:feature/test',
        async () => {
          throw new Error('HTTP 429: API rate limit exceeded')
        }
      ],
      [
        'repos/stablyai/orca/pulls?head=stablyai%3Afeature%2Ftest&state=all&per_page=10',
        async () => ({ stdout: JSON.stringify([]) })
      ],
      ['list:fork/orca:feature/test', async () => ({ stdout: JSON.stringify([]) })]
    ])

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'rate_limited'
    })
    expect(metadataCalls()[2]).toEqual([
      [
        'pr',
        'list',
        '--repo',
        'fork/orca',
        '--head',
        'feature/test',
        '--state',
        'all',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid,headRepositoryOwner,headRepository,isCrossRepository'
      ],
      { cwd: '/repo-root' }
    ])
  })
})
