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

import { getPRForBranchOutcome, getPRForBranch } from './client'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('prefers branch lookup over a fallback PR number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 43,
            title: 'Branch PR wins',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/43',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            head: { ref: 'feature/test', sha: 'branch-head-oid' },
            base: { ref: 'main', sha: 'branch-base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 43,
          title: 'Hydrated branch PR wins',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/43',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'branch-base-oid',
          headRefOid: 'branch-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 42)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 43, title: 'Hydrated branch PR wins' })
  })

  it('uses a fallback PR number only after branch lookup misses', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Fallback PR lookup',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'fallback-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 42)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'view',
        '42',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 42, title: 'Fallback PR lookup' })
  })

  it('reports upstream error when fallback branch discovery fails transiently then retry misses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'rate_limited'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'list',
        '--repo',
        'stablyai/orca',
        '--head',
        'feature/test',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/stablyai/orca/pulls?head=stablyai%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
  })

  it('propagates a Retry-After cooldown into the rate-limited retry schedule', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    // gh puts the diagnostic on `.stderr`; a secondary limit carries Retry-After.
    ghExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('gh exited with 1.'), {
          stderr: 'HTTP 403: You have exceeded a secondary rate limit\nRetry-After: 120'
        })
      )
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const before = Date.now()
    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')
    expect(outcome.kind).toBe('upstream-error')
    if (outcome.kind !== 'upstream-error') {
      throw new Error('expected upstream-error')
    }
    expect(outcome.errorType).toBe('rate_limited')
    // ~120s cooldown surfaced as both the manual gate and the auto-retry time.
    expect(outcome.retryDisabledUntil).toBeDefined()
    expect(outcome.nextAutoRetryAt).toBe(outcome.retryDisabledUntil)
    expect(outcome.retryDisabledUntil ?? 0).toBeGreaterThanOrEqual(before + 119_000)
    expect(outcome.retryDisabledUntil ?? 0).toBeLessThanOrEqual(Date.now() + 121_000)
  })

  it('reports no PR when fallback branch discovery cleanly misses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome.kind).toBe('no-pr')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('returns found when fallback branch discovery retry finds the PR', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Retry branch PR',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/42',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'feature/test', sha: 'retry-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Hydrated retry branch PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'retry-head-oid'
        })
      })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 42,
        title: 'Hydrated retry branch PR',
        prRepo: { owner: 'stablyai', repo: 'orca' }
      }
    })
  })

  it('lets fallback PR number recovery win after fallback branch queries throw', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))
      .mockResolvedValueOnce({
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
          headRefOid: 'fallback-head-oid'
        })
      })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test', null, null, 42)

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 42,
        title: 'Fallback number recovered PR'
      }
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'pr',
        'view',
        '42',
        '--repo',
        'stablyai/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('reports upstream error when fallback branch discovery has a network failure', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('could not resolve host: api.github.com'))
      .mockRejectedValueOnce(new Error('could not resolve host: api.github.com'))

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'network'
    })
  })

  it('reports a GitHub server error when fallback branch discovery receives 5xx responses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))
      .mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'server_error'
    })
  })

  it('keeps a pending fallback branch error when a later candidate cleanly misses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'rate_limited'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
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
        '1',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('treats a merged branch lookup as a miss before using a fallback PR number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged branch PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/stablyai/orca/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'feature/test', sha: 'merged-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged branch PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Open fallback PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-06-17T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'fallback-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 42)

    expect(pr).toMatchObject({ number: 42, title: 'Open fallback PR' })
  })

  it('returns a merged PR when branch lookup and fallback point at the same PR', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged current PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/acme/widgets/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'feature/test', sha: 'merged-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged current PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged current PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 5511)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'pr',
        'view',
        '5511',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 5511, state: 'merged', title: 'Merged current PR' })
  })

  it('does not carry a merged upstream branch head repo into a fallback PR number', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'orca' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'local-created-from-pr\0fork/contributor/original\n',
      stderr: ''
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged upstream branch PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/stablyai/orca/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'contributor/original', sha: 'merged-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged upstream branch PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Open fallback PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-06-17T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fresh/fallback',
          baseRefOid: 'base-oid',
          headRefOid: 'fallback-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr', null, null, 42)

    expect(pr).toMatchObject({
      number: 42,
      title: 'Open fallback PR',
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
  })

  it('ignores merged PRs discovered only from a fallback PR number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged fallback PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'add-guide-for-mobile-emulator-use',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    const pr = await getPRForBranch(
      '/repo-root',
      'add-guide-for-mobile-emulator-use',
      null,
      null,
      5511
    )

    expect(pr).toBeNull()
  })

  it('returns a merged fallback PR when visible fallback lifecycle is accepted', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged visible fallback PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'deleted-head',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'deleted-head', null, null, 5511, {
      acceptMergedFallbackPR: true
    })

    expect(pr).toMatchObject({
      number: 5511,
      state: 'merged',
      title: 'Merged visible fallback PR'
    })
  })
})
