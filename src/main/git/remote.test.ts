import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from './remote'

describe('git remote operations', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('pushes to origin when no upstream is configured', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('no branch'), { code: 1 }))

    await gitPush('/repo', true)

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD'],
      { cwd: '/repo' }
    )
  })

  it('pushes to the configured upstream remote and branch', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'review/pr-1738\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'pr-prateek-orca\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'refs/heads/prateek/fix-sidebar-agents-toggle\n',
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['config', '--get', 'branch.review/pr-1738.remote'], { cwd: '/repo' }],
      [['config', '--get', 'branch.review/pr-1738.merge'], { cwd: '/repo' }],
      [
        ['push', '--set-upstream', 'pr-prateek-orca', 'HEAD:prateek/fix-sidebar-agents-toggle'],
        { cwd: '/repo' }
      ]
    ])
  })

  it('uses an explicit push target even when it differs from the local branch name', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPush('/repo', false, {
      remoteName: 'origin',
      branchName: 'contributor/fix-sidebar'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD:contributor/fix-sidebar'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'contributor/fix-sidebar'], { cwd: '/repo' }],
      [['push', '--set-upstream', 'origin', 'HEAD:contributor/fix-sidebar'], { cwd: '/repo' }]
    ])
  })

  it('passes --force-with-lease when requested', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPush('/repo', false, undefined, { forceWithLease: true })

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--force-with-lease', '--set-upstream', 'origin', 'HEAD:feature'],
      { cwd: '/repo' }
    )
  })

  it('maps non-fast-forward push failures to an actionable message', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(new Error('remote rejected: non-fast-forward'))

    await expect(gitPush('/repo', false)).rejects.toThrow(
      'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    )
  })

  it('maps recursive submodule push failures to submodule-specific guidance', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          "Command failed: git push\nPushing submodule 'find-cmux-followers'\n" +
            ' ! [rejected]        master -> master (fetch first)\n' +
            "Unable to push submodule 'find-cmux-followers'\n" +
            'fatal: failed to push all needed submodules'
        )
      )

    await expect(gitPush('/repo', false)).rejects.toThrow(
      "Submodule 'find-cmux-followers' has remote changes. Pull inside the submodule, then try again."
    )
  })

  it('passes through clean tail line when push error does not match known patterns', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error('Command failed: git push\nfatal: something obscure happened')
      )

    await expect(gitPush('/repo', false)).rejects.toThrow('fatal: something obscure happened')
  })

  it('strips embedded credentials from push error messages', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git push\nhttps://x-access-token:ghp_abc@github.com/foo/bar.git\nfatal: remote error'
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain('ghp_abc')
    expect(caught?.message).not.toContain('x-access-token')
  })

  it('strips token-only credentials (https://TOKEN@host) from push error messages', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git push\nhttps://ghp_onlyToken@github.com/foo/bar.git\nfatal: remote error'
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).not.toContain('ghp_onlyToken')
  })

  it('falls back to a generic message for non-Error rejections', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce('string')

    await expect(gitPush('/repo', false)).rejects.toThrow('Git remote operation failed.')
  })

  it("runs pull with the user's configured strategy", async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPull('/repo')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['rev-parse', '--abbrev-ref', 'HEAD@{u}'], { cwd: '/repo' }],
      [['pull'], { cwd: '/repo' }]
    ])
  })

  it('pulls the same-name origin branch for legacy base-tracking worktrees', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPull('/repo')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['rev-parse', '--abbrev-ref', 'HEAD@{u}'], { cwd: '/repo' }],
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature'], { cwd: '/repo' }],
      [['pull', 'origin', 'feature'], { cwd: '/repo' }]
    ])
  })

  it('pulls from the explicit publish target when one is provided', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPull('/repo', {
      remoteName: 'fork',
      branchName: 'feature/fix'
    })

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['pull', 'fork', 'feature/fix'], { cwd: '/repo' }]
    ])
  })

  it('fast-forwards with --ff-only using the configured upstream', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitFastForward('/repo')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['rev-parse', '--abbrev-ref', 'HEAD@{u}'], { cwd: '/repo' }],
      [['pull', '--ff-only'], { cwd: '/repo' }]
    ])
  })

  it('fast-forwards from the explicit publish target when one is provided', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitFastForward('/repo', {
      remoteName: 'fork',
      branchName: 'feature/fix'
    })

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['pull', '--ff-only', 'fork', 'feature/fix'], { cwd: '/repo' }]
    ])
  })

  it('rebases from the selected remote base ref', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'origin\nupstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPullRebaseFromBase('/repo', 'upstream/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['remote'], { cwd: '/repo' }],
      [['check-ref-format', '--branch', 'main'], { cwd: '/repo' }],
      [['pull', '--rebase', 'upstream', 'main'], { cwd: '/repo' }]
    ])
  })

  it('uses the longest configured remote name when rebasing from a base ref', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'fork\nfork/team\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPullRebaseFromBase('/repo', 'fork/team/feature/base')

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['pull', '--rebase', 'fork/team', 'feature/base'],
      { cwd: '/repo' }
    )
  })

  it('normalizes pull authentication errors to a friendly message', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(gitPull('/repo')).rejects.toThrow(
      'Authentication failed. Check your remote credentials.'
    )
  })

  it('normalizes pull dirty-worktree aborts to a friendly message', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git pull\n' +
            'error: Your local changes to the following files would be overwritten by merge:\n' +
            '\tsrc/app.ts\n' +
            'Please commit your changes or stash them before you merge.\n' +
            'Aborting'
        )
      )

    await expect(gitPull('/repo')).rejects.toThrow(
      'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
    )
  })

  it('normalizes pull untracked-file aborts to a friendly message', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git pull\n' +
            'error: The following untracked working tree files would be overwritten by merge:\n' +
            '\tsrc/new.ts\n' +
            'Please move or remove them before you merge.\n' +
            'Aborting'
        )
      )

    await expect(gitPull('/repo')).rejects.toThrow(
      'Pull would overwrite untracked files. Move, remove, or add them before pulling.'
    )
  })

  it('runs fetch with prune', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await gitFetch('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['fetch', '--prune'], { cwd: '/repo' })
  })

  it('fetches the explicit publish target remote when provided', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitFetch('/repo', {
      remoteName: 'fork',
      branchName: 'feature/fix'
    })

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['fetch', '--prune', 'fork'], { cwd: '/repo' }]
    ])
  })

  it('fetches explicit publish target remotes whose names contain slashes', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitFetch('/repo', {
      remoteName: 'foo/bar',
      branchName: 'feature/fix'
    })

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['fetch', '--prune', 'foo/bar'], { cwd: '/repo' }]
    ])
  })

  it('normalizes fetch authentication errors to a friendly message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(gitFetch('/repo')).rejects.toThrow(
      'Authentication failed. Check your remote credentials.'
    )
  })
})
