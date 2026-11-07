import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  getRepoDefaultBranchName,
  shouldHideNonOpenReviewOnDefaultBranch,
  __resetRepoDefaultBranchCacheForTests
} from './repo-default-branch'

function primeLocalGitExec(defaultRef = 'refs/remotes/origin/master'): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
      return { stdout: `refs/remotes/origin/HEAD\0${defaultRef}\n`, stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

describe('getRepoDefaultBranchName', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    __resetRepoDefaultBranchCacheForTests()
  })

  it('returns null without running local git when the SSH provider is unavailable', async () => {
    await expect(getRepoDefaultBranchName('/remote/repo', 'ssh-gone')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('scopes the cache per runtime so WSL and host resolutions do not collide', async () => {
    primeLocalGitExec('refs/remotes/origin/master')
    await expect(getRepoDefaultBranchName('/repo')).resolves.toBe('master')

    primeLocalGitExec('refs/remotes/origin/main')
    await expect(getRepoDefaultBranchName('/repo', null, { wslDistro: 'Ubuntu' })).resolves.toBe(
      'main'
    )
  })
})

describe('shouldHideNonOpenReviewOnDefaultBranch', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    __resetRepoDefaultBranchCacheForTests()
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
