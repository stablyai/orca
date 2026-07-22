import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

import {
  getRepoDefaultBranchName,
  shouldHideNonOpenReviewOnDefaultBranch,
  __resetRepoDefaultBranchCacheForTests
} from './repo-default-branch'

function primeLocalGitExec(defaultRef = 'refs/remotes/origin/master'): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
      return { stdout: `${defaultRef}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args.includes(defaultRef)) {
      return { stdout: 'default-oid\n', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

describe('getRepoDefaultBranchName', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    __resetRepoDefaultBranchCacheForTests()
  })

  it('resolves the default branch name locally, stripping the origin/ remote prefix', async () => {
    primeLocalGitExec('refs/remotes/origin/master')

    await expect(getRepoDefaultBranchName('/repo')).resolves.toBe('master')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      // Why: the timeout keeps a dead filesystem from wedging the serial PR
      // refresh drain — assert it stays armed on the local path.
      { cwd: '/repo', timeout: expect.any(Number) }
    )
  })

  it('forwards the WSL distro to the local git exec options', async () => {
    primeLocalGitExec('refs/remotes/origin/main')

    await expect(getRepoDefaultBranchName('/repo', null, { wslDistro: 'Ubuntu' })).resolves.toBe(
      'main'
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      { cwd: '/repo', wslDistro: 'Ubuntu', timeout: expect.any(Number) }
    )
  })

  it('routes resolution through the SSH provider exec and never local git', async () => {
    const provider = {
      exec: vi.fn(async (args: string[], repoPath: string) => {
        expect(repoPath).toBe('/remote/repo')
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'refs/remotes/origin/trunk\n' }
        }
        return { stdout: 'oid\n' }
      })
    }
    getSshGitProviderMock.mockReturnValue(provider)

    await expect(getRepoDefaultBranchName('/remote/repo', 'ssh-1')).resolves.toBe('trunk')
    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-1')
    expect(provider.exec).toHaveBeenCalledWith(
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      '/remote/repo',
      { timeoutMs: expect.any(Number) }
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('shares one wall-clock timeout budget across all fallback probes', async () => {
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    gitExecFileAsyncMock.mockImplementation(async (_args, options: { timeout: number }) => {
      now += options.timeout
      throw new Error('git timed out.')
    })

    try {
      await expect(getRepoDefaultBranchName('/repo')).resolves.toBeNull()

      // Once the first probe consumes the budget, fallback refs fail open
      // without spawning four more equally slow git processes.
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(gitExecFileAsyncMock.mock.calls[0]?.[1]).toEqual({
        cwd: '/repo',
        timeout: 15_000
      })
    } finally {
      dateNow.mockRestore()
    }
  })

  it('returns null without running local git when the SSH provider is unavailable', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)

    await expect(getRepoDefaultBranchName('/remote/repo', 'ssh-gone')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null when no default branch is resolvable (fail open)', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('fatal: not a git repository'))

    await expect(getRepoDefaultBranchName('/repo')).resolves.toBeNull()
  })

  it('serves cached results within the TTL and re-executes after a reset', async () => {
    primeLocalGitExec('refs/remotes/origin/master')

    await expect(getRepoDefaultBranchName('/repo')).resolves.toBe('master')
    const callsAfterFirst = gitExecFileAsyncMock.mock.calls.length
    await expect(getRepoDefaultBranchName('/repo')).resolves.toBe('master')
    expect(gitExecFileAsyncMock.mock.calls.length).toBe(callsAfterFirst)

    __resetRepoDefaultBranchCacheForTests()
    await expect(getRepoDefaultBranchName('/repo')).resolves.toBe('master')
    expect(gitExecFileAsyncMock.mock.calls.length).toBeGreaterThan(callsAfterFirst)
  })

  it('coalesces concurrent resolutions for the same repo and runtime', async () => {
    let releaseSymbolicRef: (() => void) | undefined
    const symbolicRefGate = new Promise<void>((resolve) => {
      releaseSymbolicRef = resolve
    })
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        await symbolicRefGate
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: 'default-oid\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })

    const first = getRepoDefaultBranchName('/repo')
    const second = getRepoDefaultBranchName('/repo')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1))
    releaseSymbolicRef?.()

    await expect(Promise.all([first, second])).resolves.toEqual(['main', 'main'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('scopes the cache per runtime so WSL and host resolutions do not collide', async () => {
    primeLocalGitExec('refs/remotes/origin/master')
    await expect(getRepoDefaultBranchName('/repo')).resolves.toBe('master')

    primeLocalGitExec('refs/remotes/origin/main')
    // Same repoPath, different runtime key → fresh resolution, not the host's.
    await expect(getRepoDefaultBranchName('/repo', null, { wslDistro: 'Ubuntu' })).resolves.toBe(
      'main'
    )
  })
})

describe('shouldHideNonOpenReviewOnDefaultBranch', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    __resetRepoDefaultBranchCacheForTests()
  })

  it('never resolves the default branch for open or draft reviews (lazy)', async () => {
    for (const state of ['open', 'opened', 'draft']) {
      await expect(
        shouldHideNonOpenReviewOnDefaultBranch({
          state,
          reviewNumber: 1,
          branchName: 'master',
          repoPath: '/repo'
        })
      ).resolves.toBe(false)
    }
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('hides a closed review whose branch is the repo default branch', async () => {
    primeLocalGitExec('refs/remotes/origin/master')

    await expect(
      shouldHideNonOpenReviewOnDefaultBranch({
        state: 'closed',
        reviewNumber: 7,
        branchName: 'master',
        repoPath: '/repo'
      })
    ).resolves.toBe(true)
  })

  it('hides a stuck-locked review whose branch is the repo default branch', async () => {
    primeLocalGitExec('refs/remotes/origin/master')

    await expect(
      shouldHideNonOpenReviewOnDefaultBranch({
        state: 'locked',
        reviewNumber: 7,
        branchName: 'master',
        repoPath: '/repo'
      })
    ).resolves.toBe(true)
  })

  it('keeps a closed review on a non-default branch', async () => {
    primeLocalGitExec('refs/remotes/origin/master')

    await expect(
      shouldHideNonOpenReviewOnDefaultBranch({
        state: 'closed',
        reviewNumber: 7,
        branchName: 'feature-x',
        repoPath: '/repo'
      })
    ).resolves.toBe(false)
  })

  it('exempts the explicitly linked review without resolving the default branch', async () => {
    await expect(
      shouldHideNonOpenReviewOnDefaultBranch({
        state: 'merged',
        reviewNumber: 7,
        linkedReviewNumber: 7,
        branchName: 'master',
        repoPath: '/repo'
      })
    ).resolves.toBe(false)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('still hides a non-open shadow whose number differs from the linked review', async () => {
    primeLocalGitExec('refs/remotes/origin/master')

    await expect(
      shouldHideNonOpenReviewOnDefaultBranch({
        state: 'merged',
        reviewNumber: 7,
        linkedReviewNumber: 42,
        branchName: 'master',
        repoPath: '/repo'
      })
    ).resolves.toBe(true)
  })

  it('fails open when the default branch is unresolvable', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('fatal: not a git repository'))

    await expect(
      shouldHideNonOpenReviewOnDefaultBranch({
        state: 'closed',
        reviewNumber: 7,
        branchName: 'master',
        repoPath: '/repo'
      })
    ).resolves.toBe(false)
  })
})
