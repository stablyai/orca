import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitHubClient from '../github/client'

const getPRForBranchMock = vi.hoisted(() => vi.fn())
const git = vi.hoisted(() => vi.fn())
const worktrees = vi.hoisted(() => vi.fn())
vi.mock('../git/runner', () => ({ gitExecFileAsync: git }))
vi.mock('../git/worktree', () => ({ listWorktrees: worktrees }))

vi.mock('../github/client', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClient>()),
  getPRForBranch: getPRForBranchMock
}))

import {
  canCheckoutExistingLocalBranch,
  getLocalGitHubPrForBranch
} from './runtime-worktree-create-git'

beforeEach(() => {
  getPRForBranchMock.mockReset()
  getPRForBranchMock.mockResolvedValue(null)
  git.mockReset()
  worktrees.mockReset()
})

describe('explicit local branch reuse on the execution host', () => {
  it('routes all probes through the WSL distro and does not compare or reset the remote tip', async () => {
    git.mockResolvedValueOnce({ stdout: 'local-ahead\n' })
    git.mockResolvedValueOnce({ stdout: 'refs/heads/feature/test\n' })
    worktrees.mockResolvedValue([])
    await expect(
      canCheckoutExistingLocalBranch(
        '/repo',
        'feature/test',
        'origin/feature/test',
        { wslDistro: 'Ubuntu' },
        true
      )
    ).resolves.toBe(true)
    expect(git.mock.calls).toEqual([
      [
        ['rev-parse', '--verify', '--quiet', 'refs/heads/feature/test^{commit}'],
        { cwd: '/repo', wslDistro: 'Ubuntu' }
      ],
      [
        ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/test'],
        { cwd: '/repo', wslDistro: 'Ubuntu' }
      ]
    ])
    expect(worktrees).toHaveBeenCalledWith('/repo', { wslDistro: 'Ubuntu' })
  })

  it('rejects a filesystem alias before attempting checkout through WSL', async () => {
    git.mockResolvedValueOnce({ stdout: 'local-ahead\n' })
    git.mockResolvedValueOnce({ stdout: '' })
    await expect(
      canCheckoutExistingLocalBranch(
        '/repo',
        'feature/TEST',
        'origin/feature/test',
        { wslDistro: 'Ubuntu' },
        true
      )
    ).rejects.toThrow('Select its exact branch name')
    expect(worktrees).not.toHaveBeenCalled()
  })

  it('detects a busy alias recorded by an older checkout through WSL', async () => {
    git.mockResolvedValueOnce({ stdout: 'local-ahead\n' })
    git.mockResolvedValueOnce({ stdout: 'refs/heads/feature/test\n' })
    git.mockResolvedValueOnce({ stdout: '' })
    worktrees.mockResolvedValue([{ path: '/busy', branch: 'refs/heads/feature/TEST' }])
    await expect(
      canCheckoutExistingLocalBranch(
        '/repo',
        'feature/test',
        'origin/feature/test',
        { wslDistro: 'Ubuntu' },
        true
      )
    ).rejects.toThrow('already checked out at "/busy"')
    expect(git).toHaveBeenLastCalledWith(
      ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/TEST'],
      { cwd: '/repo', wslDistro: 'Ubuntu' }
    )
  })

  it('propagates an unreadable local ref instead of treating it as permission to create', async () => {
    git.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 128 }))
    await expect(
      canCheckoutExistingLocalBranch('/repo', 'feature/test', 'origin/feature/test', {}, true)
    ).rejects.toThrow('permission denied')
    expect(worktrees).not.toHaveBeenCalled()
  })
})

describe('getLocalGitHubPrForBranch', () => {
  it('routes the PR lookup through the WSL distro', async () => {
    await getLocalGitHubPrForBranch('/repo', 'app', { wslDistro: 'Ubuntu' })

    expect(getPRForBranchMock).toHaveBeenCalledWith('/repo', 'app', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
  })

  it('uses the plain lookup without project git options', async () => {
    await getLocalGitHubPrForBranch('/repo', 'app', {})

    expect(getPRForBranchMock).toHaveBeenCalledWith('/repo', 'app')
  })
})
