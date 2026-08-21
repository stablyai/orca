import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import { REMOTE_TRACKING_FETCH_TIMEOUT_MS } from '../../shared/git-remote-tracking-fetch-timeout'
import { gitExecFileAsync } from '../git/runner'
import { createLocalWorktreePushTargetGit } from './worktree-push-target-git'

vi.mock('../git/runner', () => ({ gitExecFileAsync: vi.fn() }))

const execGit = vi.mocked(gitExecFileAsync)
const target = {
  remoteName: 'pr-contributor-orca',
  branchName: 'contributor/fix',
  remoteUrl: 'git@github.com:contributor/orca.git'
}

describe('local worktree push-target git adapter', () => {
  beforeEach(() => {
    execGit.mockReset()
    execGit.mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('preserves WSL routing for setup commands', async () => {
    const git = createLocalWorktreePushTargetGit({ wslDistro: 'Ubuntu' })

    await git.addRemote('C:\\repo', target)
    await git.fetchRemoteTrackingRef('C:\\repo', target)
    await git.configureUpstream('C:\\repo-fix', 'local-fix', target)

    expect(execGit).toHaveBeenNthCalledWith(
      1,
      ['remote', 'add', target.remoteName, target.remoteUrl],
      { cwd: 'C:\\repo', wslDistro: 'Ubuntu' }
    )
    expect(execGit).toHaveBeenNthCalledWith(
      2,
      [
        ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
        'fetch',
        target.remoteName,
        `+refs/heads/${target.branchName}:refs/remotes/${target.remoteName}/${target.branchName}`
      ],
      {
        cwd: 'C:\\repo',
        wslDistro: 'Ubuntu',
        timeout: REMOTE_TRACKING_FETCH_TIMEOUT_MS
      }
    )
    expect(execGit).toHaveBeenNthCalledWith(
      3,
      ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, 'local-fix'],
      { cwd: 'C:\\repo-fix', wslDistro: 'Ubuntu' }
    )
  })

  it('checks the configured URL once before removing a matching remote', async () => {
    execGit.mockResolvedValueOnce({
      stdout: 'https://github.com/contributor/orca.git\n',
      stderr: ''
    })
    const git = createLocalWorktreePushTargetGit()

    await git.removeRemoteIfMatches('/repo', target)

    expect(execGit.mock.calls).toEqual([
      [['remote', 'get-url', target.remoteName], { cwd: '/repo' }],
      [['remote', 'remove', target.remoteName], { cwd: '/repo' }]
    ])
  })

  it('keeps a remote whose HTTPS endpoint uses a non-default port', async () => {
    execGit.mockResolvedValueOnce({
      stdout: 'https://github.com:8443/contributor/orca.git\n',
      stderr: ''
    })
    const git = createLocalWorktreePushTargetGit()

    await git.removeRemoteIfMatches('/repo', target)

    expect(execGit).toHaveBeenCalledTimes(1)
  })

  it('keeps a remote whose SSH endpoint uses a non-default port', async () => {
    execGit.mockResolvedValueOnce({
      stdout: 'ssh://git@github.com:2222/contributor/orca.git\n',
      stderr: ''
    })
    const git = createLocalWorktreePushTargetGit()

    await git.removeRemoteIfMatches('/repo', target)

    expect(execGit).toHaveBeenCalledTimes(1)
  })
})
