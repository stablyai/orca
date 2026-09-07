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
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('uses the tracked upstream remote owner for fork branch lookup', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'Fork upstream branch PR',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/78',
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
          title: 'Hydrated fork upstream branch PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/78',
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
      stdout: 'local-created-from-pr\0fork/contributor/original\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'fork', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'api',
        'repos/stablyai/orca/pulls?head=fork-owner%3Acontributor%2Foriginal&state=all&per_page=1'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 78,
      title: 'Hydrated fork upstream branch PR',
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'fork-owner', repo: 'orca' }
    })
  })

  it('uses the tracked upstream remote owner when the fork branch name matches locally', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'brennanb2025', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 6433,
            title: 'Recover Windows worktree deletes from long paths',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/6433',
            updated_at: '2026-06-26T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: {
              ref: 'brennanb2025/worktree-remove-fix',
              sha: 'same-name-fork-head-oid'
            }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 6433,
          title: 'Recover Windows worktree deletes from long paths',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/6433',
          statusCheckRollup: [],
          updatedAt: '2026-06-26T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'brennanb2025/worktree-remove-fix',
          baseRefOid: 'base-oid',
          headRefOid: 'same-name-fork-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'brennanb2025/worktree-remove-fix\0brennan/brennanb2025/worktree-remove-fix\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'brennanb2025/worktree-remove-fix')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'brennan', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'api',
        'repos/stablyai/orca/pulls?head=brennanb2025%3Abrennanb2025%2Fworktree-remove-fix&state=all&per_page=1'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 6433,
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'brennanb2025', repo: 'orca' }
    })
  })

  it('does not retry same-name tracked upstream lookup for the same head repo', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'feature/no-pr\0origin/feature/no-pr\n',
      stderr: ''
    })

    await expect(getPRForBranch('/repo-root', 'feature/no-pr')).resolves.toBeNull()

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'origin', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Fno-pr&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
  })

  it('checks the tracked upstream branch through the SSH git provider', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: 'local-created-from-pr\0origin/contributor/original\n',
        stderr: ''
      })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'SSH upstream branch PR',
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

    const pr = await getPRForBranch(
      '/remote/repo-root',
      'local-created-from-pr',
      undefined,
      'ssh-1'
    )

    expect(sshGitProvider.exec).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads'],
      '/remote/repo-root'
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Acontributor%2Foriginal&state=all&per_page=1'],
      {}
    )
    expect(pr).toMatchObject({ number: 78, title: 'SSH upstream branch PR' })
  })

  it('uses the same-name tracked upstream fork owner through the SSH git provider', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: 'contributor/fix\0fork/contributor/fix\n',
        stderr: ''
      })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 79,
            title: 'SSH same-name fork PR',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/79',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/fix', sha: 'same-name-ssh-head-oid' }
          }
        ])
      })

    const pr = await getPRForBranch('/remote/repo-root', 'contributor/fix', undefined, 'ssh-1')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/remote/repo-root', 'fork', 'ssh-1')
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', 'repos/stablyai/orca/pulls?head=fork-owner%3Acontributor%2Ffix&state=all&per_page=1'],
      {}
    )
    expect(pr).toMatchObject({
      number: 79,
      title: 'SSH same-name fork PR',
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'fork-owner', repo: 'orca' }
    })
  })

  it('caches positive tracked-upstream entries for unsigned SSH runtimes during PR refresh polling', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: 'refs/heads/feature\0origin/contributor/original\n',
        stderr: ''
      })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })

    await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')
    await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')
    await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')

    expect(sshGitProvider.exec).toHaveBeenCalledTimes(1)
  })

  it('refreshes positive tracked-upstream entries for unsigned SSH runtimes after the TTL', async () => {
    vi.useFakeTimers()
    try {
      const sshGitProvider = {
        exec: vi
          .fn()
          .mockResolvedValueOnce({
            stdout: 'refs/heads/feature\0origin/old-upstream\n',
            stderr: ''
          })
          .mockResolvedValueOnce({
            stdout: 'refs/heads/feature\0origin/contributor/original\n',
            stderr: ''
          })
      }
      getSshGitProviderMock.mockReturnValue(sshGitProvider)
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
        .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
        .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              number: 81,
              title: 'Fresh SSH upstream PR',
              state: 'open',
              html_url: 'https://github.com/acme/widgets/pull/81',
              updated_at: '2026-03-28T00:00:00Z',
              draft: false,
              mergeable: true,
              base: { ref: 'main', sha: 'base-oid' },
              head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
            }
          ])
        })

      await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')
      await vi.advanceTimersByTimeAsync(30_001)
      const pr = await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')

      expect(sshGitProvider.exec).toHaveBeenCalledTimes(2)
      expect(pr).toMatchObject({
        number: 81,
        title: 'Fresh SSH upstream PR'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
