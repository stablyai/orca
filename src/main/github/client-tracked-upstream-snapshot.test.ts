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

import {
  getPRForBranch,
  _getTrackedUpstreamBranchCacheSizesForTests,
  __resetTrackedUpstreamBranchCacheForTests
} from './client'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  readLocalGitConfigSignatureMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('falls back to the tracked upstream branch when the local branch name differs', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'Upstream branch PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/78',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 78,
          title: 'Hydrated upstream branch PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/78',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'local-created-from-pr\0origin/contributor/original\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Alocal-created-from-pr&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Acontributor%2Foriginal&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'pr',
        'view',
        '78',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 78,
      title: 'Hydrated upstream branch PR',
      headSha: 'upstream-head-oid'
    })
  })

  it('does not repeat missing tracked-upstream probes during PR refresh polling', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'no-pr-branch\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(1)
  })

  it('releases tracked-upstream probe generations across runtime identities', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({ stdout: 'feature\0\n', stderr: '' })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'feature\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'feature')
    await getPRForBranch('/repo-root', 'feature', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
    await getPRForBranch('/repo-root', 'feature', null, 'ssh-1')

    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 3,
      inFlight: 0,
      generations: 0
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(sshGitProvider.exec).toHaveBeenCalledTimes(1)
  })

  it('bounds unique tracked-upstream snapshots and sweeps expired identities', async () => {
    vi.useFakeTimers()
    try {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
      gitExecFileAsyncMock.mockResolvedValue({ stdout: 'feature\0\n', stderr: '' })

      for (let index = 0; index < 513; index += 1) {
        await getPRForBranch(`/repo-root-${index}`, 'feature')
      }
      await getPRForBranch('/repo-root-512', 'feature')

      expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
        snapshots: 512,
        inFlight: 0,
        generations: 0
      })
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(513)

      await vi.advanceTimersByTimeAsync(30_001)
      await getPRForBranch('/repo-root-fresh', 'feature')

      expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
        snapshots: 1,
        inFlight: 0,
        generations: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps stale probe cleanup from releasing a replacement generation', async () => {
    let resolveOldProbe: (value: { stdout: string; stderr: string }) => void
    let resolveCurrentProbe: (value: { stdout: string; stderr: string }) => void
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldProbe = resolve
          })
      )
      .mockResolvedValueOnce({ stdout: 'replacement\0\n', stderr: '' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCurrentProbe = resolve
          })
      )

    const oldLookup = getPRForBranch('/repo-root', 'old')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1))
    __resetTrackedUpstreamBranchCacheForTests()
    await getPRForBranch('/repo-root', 'replacement')
    const currentLookup = getPRForBranch('/repo-root', 'current')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3))

    resolveOldProbe!({ stdout: 'old\0\n', stderr: '' })
    await oldLookup
    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 0,
      inFlight: 1,
      generations: 1
    })

    resolveCurrentProbe!({ stdout: 'current\0\n', stderr: '' })
    await currentLookup
    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 1,
      inFlight: 0,
      generations: 0
    })
  })

  it('releases tracked-upstream probe state when setup rejects', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    readLocalGitConfigSignatureMock.mockRejectedValue(new Error('git config unavailable'))

    await expect(getPRForBranch('/repo-root', 'feature')).resolves.toBeNull()
    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 0,
      inFlight: 0,
      generations: 0
    })
  })

  it('does not fan out tracked-upstream probes after a transient for-each-ref failure', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fatal: cannot lock ref'))
      .mockResolvedValue({ stdout: 'alpha\0\nbeta\0\ngamma\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'alpha')
    await getPRForBranch('/repo-root', 'beta')
    await getPRForBranch('/repo-root', 'gamma')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
  })

  it('refreshes the tracked-upstream snapshot when a branch appears inside the TTL', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'existing\0\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'existing\0\nnew-feature\0origin/contributor/original\n',
        stderr: ''
      })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'New branch upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/78',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 78,
          title: 'Hydrated new branch upstream PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/78',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    await getPRForBranch('/repo-root', 'existing')
    const pr = await getPRForBranch('/repo-root', 'new-feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 78,
      title: 'Hydrated new branch upstream PR'
    })
  })

  it('parses full local branch refs from the tracked-upstream snapshot', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'refs/heads/feature\0origin/contributor/original\n',
      stderr: ''
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 80,
            title: 'Ambiguous ref upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/80',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 80,
          title: 'Hydrated ambiguous ref upstream PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/80',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature')

    expect(pr).toMatchObject({
      number: 80,
      title: 'Hydrated ambiguous ref upstream PR'
    })
  })

  it('parses full upstream refs from the tracked-upstream snapshot', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'refs/heads/feature\0refs/remotes/fork/contributor/original\n',
      stderr: ''
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 83,
            title: 'Full upstream ref PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/83',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 83,
          title: 'Hydrated full upstream ref PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/83',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'fork', undefined)
    expect(pr).toMatchObject({
      number: 83,
      title: 'Hydrated full upstream ref PR',
      headRepo: { owner: 'fork-owner', repo: 'widgets' }
    })
  })

  it('ignores full local-branch upstream refs from the tracked-upstream snapshot', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'refs/heads/feature\0refs/heads/main\n',
      stderr: ''
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const pr = await getPRForBranch('/repo-root', 'feature')

    expect(pr).toBeNull()
    expect(getOwnerRepoForRemoteMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('invalidates the local tracked-upstream snapshot when git config changes', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 79,
            title: 'Reconfigured upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/79',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 79,
          title: 'Hydrated reconfigured upstream PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/79',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    await getPRForBranch('/repo-root', 'feature')
    const pr = await getPRForBranch('/repo-root', 'feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 79,
      title: 'Hydrated reconfigured upstream PR'
    })
  })

  it('does not cache positive tracked-upstream entries when config changes during the snapshot', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\0origin/old-upstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 82,
            title: 'Stable config upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/82',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    await getPRForBranch('/repo-root', 'feature')
    const pr = await getPRForBranch('/repo-root', 'feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 82,
      title: 'Stable config upstream PR'
    })
  })

  it('does not cache null tracked-upstream entries when config changes during the snapshot', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 85,
            title: 'Unstable config upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/85',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    await getPRForBranch('/repo-root', 'feature')
    const pr = await getPRForBranch('/repo-root', 'feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 85,
      title: 'Unstable config upstream PR'
    })
  })

  it('coalesces concurrent missing tracked-upstream probes', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockImplementation(async () => {
      await Promise.resolve()
      return { stdout: 'no-pr-branch\0\n', stderr: '' }
    })

    await Promise.all([
      getPRForBranch('/repo-root', 'no-pr-branch'),
      getPRForBranch('/repo-root', 'no-pr-branch'),
      getPRForBranch('/repo-root', 'no-pr-branch')
    ])

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(1)
  })

  it('does not cache synthetic nulls from concurrent tracked-upstream waiters', async () => {
    let resolveSnapshot: (value: { stdout: string; stderr: string }) => void
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock.mockResolvedValue(
      '/repo-root/.git/config\u0000mtime-a\u0000100'
    )
    gitExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve
          })
      )
      .mockResolvedValueOnce({ stdout: 'new-feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 84,
            title: 'Concurrent waiter upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/84',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    const existingLookup = getPRForBranch('/repo-root', 'existing')
    const waiterLookup = getPRForBranch('/repo-root', 'new-feature')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1))
    resolveSnapshot!({ stdout: 'existing\0\n', stderr: '' })
    const [, waiterPr] = await Promise.all([existingLookup, waiterLookup])

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(waiterPr).toMatchObject({
      number: 84,
      title: 'Concurrent waiter upstream PR'
    })
  })

  it('keeps missing tracked-upstream probes separate for host and WSL runtimes', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'no-pr-branch\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(trackedUpstreamCalls[0][1]).toEqual({ cwd: '/repo-root' })
    expect(trackedUpstreamCalls[1][1]).toEqual({
      cwd: '/repo-root',
      wslDistro: 'Ubuntu'
    })
  })

  it('rechecks missing tracked-upstream probes after the null-cache TTL expires', async () => {
    vi.useFakeTimers()
    try {
      resolvePRRepositoryCandidatesMock.mockResolvedValue({
        candidates: [{ owner: 'acme', repo: 'widgets' }],
        headRepo: { owner: 'acme', repo: 'widgets' }
      })
      ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error("fatal: no upstream configured for branch 'feature'"))
        .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })

      await getPRForBranch('/repo-root', 'feature')
      await vi.advanceTimersByTimeAsync(30_001)
      await getPRForBranch('/repo-root', 'feature')

      const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
        (args as string[]).includes('refs/heads')
      )
      expect(trackedUpstreamCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
