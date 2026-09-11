import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { REBASE_SOURCE_FETCH_TIMEOUT_MS } from '../../shared/git-rebase-source'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from './remote'

const REBASE_OPERATION_OPTIONS = {
  cwd: '/repo',
  terminationBarrier: true,
  captureWslLoginShellOutput: true
}

describe('git remote operations', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    clearGitCapabilityStateForTests()
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
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'review/pr-1738\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1738.remote')) {
        return { stdout: 'pr-prateek-orca\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1738.pushRemote')) {
        return { stdout: 'pr-prateek-orca\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1738.merge')) {
        return { stdout: 'refs/heads/prateek/fix-sidebar-agents-toggle\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1738.base')) {
        throw new Error('missing branch base')
      }
      return { stdout: '', stderr: '' }
    })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', '--get', 'branch.review/pr-1738.remote'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'pr-prateek-orca', 'HEAD:prateek/fix-sidebar-agents-toggle'],
      { cwd: '/repo' }
    )
  })

  it('does not combine remote.pushDefault with a base-branch merge target', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'feature/fix\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.remote')) {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.pushRemote')) {
        throw new Error('missing pushRemote')
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.merge')) {
        return { stdout: 'refs/heads/main\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.base')) {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['push', '--set-upstream', 'fork', 'HEAD:main'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'origin', 'HEAD'],
      { cwd: '/repo' }
    )
  })

  it('keeps a fork head target when the contributor branch matches the base branch name', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'review/pr-1\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.remote')) {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.pushRemote')) {
        return { stdout: 'fork\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.merge')) {
        return { stdout: 'refs/heads/main\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.base')) {
        return { stdout: 'refs/remotes/origin/main\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'fork', 'HEAD:main'],
      { cwd: '/repo' }
    )
  })

  it('pushes to a URL-valued branch pushRemote when no named remote exists', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'imp/chinese-translation\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.pushRemote')) {
        return { stdout: 'https://github.com/pynickle/orca.git\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        throw new Error('missing pushDefault')
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return { stdout: 'https://github.com/pynickle/orca.git\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return { stdout: 'refs/heads/imp/chinese-translation\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: 'https://github.com/stablyai/orca.git\n', stderr: '' }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      [
        'push',
        '--set-upstream',
        'https://github.com/pynickle/orca.git',
        'HEAD:imp/chinese-translation'
      ],
      { cwd: '/repo' }
    )
  })

  it('normalizes a URL-valued branch remote to a matching named remote before pushing', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'imp/chinese-translation\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.pushRemote')) {
        throw new Error('missing pushRemote')
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        throw new Error('missing pushDefault')
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return { stdout: 'https://github.com/pynickle/orca.git\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return { stdout: 'refs/heads/imp/chinese-translation\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return { stdout: 'https://github.com/stablyai/orca.git\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'pr-pynickle-orca') {
        return { stdout: 'https://github.com/pynickle/orca.git\n', stderr: '' }
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        return {
          stdout: [
            'origin\thttps://github.com/stablyai/orca.git (fetch)',
            'origin\thttps://github.com/stablyai/orca.git (push)',
            'pr-pynickle-orca\thttps://github.com/pynickle/orca.git (fetch)',
            'pr-pynickle-orca\thttps://github.com/pynickle/orca.git (push)'
          ].join('\n'),
          stderr: ''
        }
      }
      if (args[0] === 'remote') {
        return { stdout: 'origin\npr-pynickle-orca\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    await gitPush('/repo', false)

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'pr-pynickle-orca', 'HEAD:imp/chinese-translation'],
      { cwd: '/repo' }
    )
  })

  // Regression: normalizing a URL-valued push remote used to run `git remote` and then a
  // serial `git remote get-url` per remote -- 59 subprocesses on a 58-remote repo.
  it('normalizes a URL-valued push remote from one remote table read at 58 remotes', async () => {
    const remotes = [
      { name: 'origin', url: 'https://github.com/stablyai/orca.git' },
      ...Array.from({ length: 56 }, (_, index) => ({
        name: `pr-user${index}-orca`,
        url: `https://github.com/user${index}/orca.git`
      })),
      { name: 'pr-pynickle-orca', url: 'https://github.com/pynickle/orca.git' }
    ]
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'imp/chinese-translation\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return { stdout: 'https://github.com/pynickle/orca.git\n', stderr: '' }
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return { stdout: 'refs/heads/imp/chinese-translation\n', stderr: '' }
      }
      if (args[0] === 'config') {
        throw new Error(`config key is not set: ${args.join(' ')}`)
      }
      if (args[0] === 'remote' && args[1] === '-v') {
        return {
          stdout: remotes
            .flatMap(({ name, url }) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
            .join('\n'),
          stderr: ''
        }
      }
      if (args[0] === 'remote') {
        throw new Error(`unexpected remote scan: ${args.join(' ')}`)
      }
      return { stdout: '', stderr: '' }
    })

    await gitPush('/repo', false)

    const remoteReads = gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'remote')
    expect(remoteReads.map(([args]) => args)).toEqual([['remote', '-v']])
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['push', '--set-upstream', 'pr-pynickle-orca', 'HEAD:imp/chinese-translation'],
      { cwd: '/repo' }
    )
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

  it('preserves redacted pre-push hook output from failed pushes', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('no branch'))
      .mockRejectedValueOnce(
        new Error(
          [
            'Command failed: git push https://x-access-token:ghp_secret@github.com/acme/repo.git HEAD',
            'husky - pre-push hook failed',
            'eslint found 2 errors',
            "error: failed to push some refs to 'https://ghp_tailSecret@github.com/acme/repo.git'"
          ].join('\n')
        )
      )

    let caught: Error | undefined
    try {
      await gitPush('/repo', false)
    } catch (error) {
      caught = error as Error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught?.message).toContain('husky - pre-push hook failed')
    expect(caught?.message).toContain('eslint found 2 errors')
    expect(caught?.message).not.toContain('x-access-token')
    expect(caught?.message).not.toContain('ghp_secret')
    expect(caught?.message).not.toContain('ghp_tailSecret')
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

  it('retries a divergent pull as a merge when no strategy is configured', async () => {
    const divergentError = new Error(
      'Command failed: git pull\n' + 'fatal: Need to specify how to reconcile divergent branches.'
    )
    gitExecFileAsyncMock
      // First attempt: plain pull rejects with git's reconciliation error.
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(divergentError)
      // Fallback attempt: pull --no-rebase (merge) succeeds.
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPull('/repo')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['rev-parse', '--abbrev-ref', 'HEAD@{u}'], { cwd: '/repo' }],
      [['pull'], { cwd: '/repo' }],
      [['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: '/repo' }],
      [['rev-parse', '--abbrev-ref', 'HEAD@{u}'], { cwd: '/repo' }],
      [['pull', '--no-rebase'], { cwd: '/repo' }]
    ])
  })

  it('does not retry a fast-forward-only pull that fails on divergence', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(
        new Error('Command failed: git pull\nfatal: Not possible to fast-forward, aborting.')
      )

    await expect(gitFastForward('/repo')).rejects.toThrow('Not possible to fast-forward')
    // No fallback attempt: only the three probe/pull calls ran.
    expect(gitExecFileAsyncMock.mock.calls).toHaveLength(3)
  })

  it('retries a divergent pushTarget pull as a merge when no strategy is configured', async () => {
    const divergentError = new Error(
      'Command failed: git pull\n' + 'fatal: Need to specify how to reconcile divergent branches.'
    )
    gitExecFileAsyncMock
      // First attempt: validate the target, then the plain pull rejects.
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(divergentError)
      // Fallback attempt: re-validate, then pull --no-rebase (merge) succeeds.
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPull('/repo', { remoteName: 'fork', branchName: 'feature/fix' })

    // The merge flag is spliced ahead of the positional remote/branch args.
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['pull', 'fork', 'feature/fix'], { cwd: '/repo' }],
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['pull', '--no-rebase', 'fork', 'feature/fix'], { cwd: '/repo' }]
    ])
  })

  it('surfaces a normalized error and does not loop when the merge fallback itself fails', async () => {
    const divergentError = new Error(
      'Command failed: git pull\n' + 'fatal: Need to specify how to reconcile divergent branches.'
    )
    const mergeConflictError = new Error(
      'Command failed: git pull --no-rebase\nCONFLICT (content): Merge conflict in file.txt'
    )
    gitExecFileAsyncMock
      // First attempt fails with the reconciliation error.
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(divergentError)
      // The single merge fallback then fails on a real conflict.
      .mockResolvedValueOnce({ stdout: 'feature\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n', stderr: '' })
      .mockRejectedValueOnce(mergeConflictError)

    await expect(gitPull('/repo')).rejects.toThrow()
    // At-most-once retry: probe+pull, then probe+fallback-pull — no further attempts.
    expect(gitExecFileAsyncMock.mock.calls).toHaveLength(6)
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

  it('fetches to a private ref then rebases from the selected remote base ref', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'origin\nupstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'fork-point\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPullRebaseFromBase('/repo', 'upstream/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['remote'], REBASE_OPERATION_OPTIONS],
      [['check-ref-format', '--branch', 'main'], REBASE_OPERATION_OPTIONS],
      [
        ['merge-base', '--fork-point', 'refs/remotes/upstream/main', 'HEAD'],
        REBASE_OPERATION_OPTIONS
      ],
      [
        [
          'fetch',
          '--no-write-fetch-head',
          'upstream',
          expect.stringMatching(/^\+refs\/heads\/main:refs\/orca\/rebase\//),
          '+refs/heads/main:refs/remotes/upstream/main'
        ],
        { ...REBASE_OPERATION_OPTIONS, timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS }
      ],
      [
        ['rebase', '--onto', expect.stringMatching(/^refs\/orca\/rebase\//), 'fork-point'],
        REBASE_OPERATION_OPTIONS
      ],
      [['update-ref', '-d', expect.stringMatching(/^refs\/orca\/rebase\//)], { cwd: '/repo' }]
    ])

    const fetchRefspec = gitExecFileAsyncMock.mock.calls[3][0][3]
    const rebasedRef = gitExecFileAsyncMock.mock.calls[4][0][2]
    const deletedRef = gitExecFileAsyncMock.mock.calls[5][0][2]
    expect(fetchRefspec).toBe(`+refs/heads/main:${rebasedRef}`)
    expect(gitExecFileAsyncMock.mock.calls[3][0][4]).toBe(
      '+refs/heads/main:refs/remotes/upstream/main'
    )
    expect(deletedRef).toBe(rebasedRef)
  })

  it('uses the longest configured remote name when rebasing from a base ref', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'fork\nfork/team\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'fork-point\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPullRebaseFromBase('/repo', 'fork/team/feature/base')

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      5,
      ['rebase', '--onto', expect.stringMatching(/^refs\/orca\/rebase\//), 'fork-point'],
      REBASE_OPERATION_OPTIONS
    )
  })

  it('rebases when the selected remote has not been fetched before', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'upstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('missing remote-tracking ref'))
      .mockResolvedValueOnce({ stdout: 'head\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(gitPullRebaseFromBase('/repo', 'upstream/main')).resolves.toBeUndefined()

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      5,
      [
        'fetch',
        '--no-write-fetch-head',
        'upstream',
        expect.stringMatching(/^\+refs\/heads\/main:refs\/orca\/rebase\//),
        '+refs/heads/main:refs/remotes/upstream/main'
      ],
      { ...REBASE_OPERATION_OPTIONS, timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS }
    )
  })

  it('fast-forwards an unborn branch from the fetched private ref', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'upstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('unborn HEAD'))
      .mockRejectedValueOnce(new Error('unborn HEAD'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPullRebaseFromBase('/repo', 'upstream/main')

    const fetchedRef = gitExecFileAsyncMock.mock.calls[4][0][3]
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      6,
      ['merge', '--ff-only', fetchedRef.slice(fetchedRef.indexOf(':') + 1)],
      REBASE_OPERATION_OPTIONS
    )
  })

  it('removes the private ref when rebase fails', async () => {
    const controller = new AbortController()
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'upstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'fork-point\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockImplementationOnce(async () => {
        controller.abort()
        throw new Error('fatal: rebase conflict')
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      gitPullRebaseFromBase('/repo', 'upstream/main', { signal: controller.signal })
    ).rejects.toThrow('fatal: rebase conflict')

    const rebasedRef = gitExecFileAsyncMock.mock.calls[4][0][2]
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(6, ['update-ref', '-d', rebasedRef], {
      cwd: '/repo'
    })
  })

  it('serializes the private fetch when Git cannot avoid writing FETCH_HEAD', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'upstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'fork-point\n', stderr: '' })
      .mockRejectedValueOnce(new Error("error: unknown option `no-write-fetch-head'"))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitPullRebaseFromBase('/repo', 'upstream/main')

    const preferredRefspecs = gitExecFileAsyncMock.mock.calls[3][0].slice(3)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      5,
      ['fetch', 'upstream', ...preferredRefspecs],
      { ...REBASE_OPERATION_OPTIONS, timeout: REBASE_SOURCE_FETCH_TIMEOUT_MS }
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

  it('passes the selected WSL distro through fetch validation and execution', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await gitFetch(
      '/repo',
      {
        remoteName: 'fork',
        branchName: 'feature/fix'
      },
      { wslDistro: 'Ubuntu' }
    )

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo', wslDistro: 'Ubuntu' }],
      [['fetch', '--prune', 'fork'], { cwd: '/repo', wslDistro: 'Ubuntu' }]
    ])
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

  it('drops a stale branch-specific refspec and retries when the fork branch was deleted upstream (#17828)', async () => {
    let fetchAttempts = 0
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'check-ref-format') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch') {
        fetchAttempts += 1
        if (fetchAttempts === 1) {
          throw Object.assign(new Error("fatal: couldn't find remote ref refs/heads/gone"), {
            stderr: "fatal: couldn't find remote ref refs/heads/gone\n"
          })
        }
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'config' && args[1] === '--get-all') {
        return {
          stdout:
            '+refs/heads/gone:refs/remotes/fork/gone\n+refs/heads/keep:refs/remotes/fork/keep\n',
          stderr: ''
        }
      }
      return { stdout: '', stderr: '' }
    })

    await gitFetch('/repo', { remoteName: 'fork', branchName: 'keep' })

    expect(fetchAttempts).toBe(2)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', '--unset-all', 'remote.fork.fetch'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', '--add', 'remote.fork.fetch', '+refs/heads/keep:refs/remotes/fork/keep'],
      { cwd: '/repo' }
    )
  })

  it('surfaces the original fetch error when it is not a stale-refspec failure', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'check-ref-format') {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch') {
        throw new Error('network unreachable')
      }
      return { stdout: '', stderr: '' }
    })

    await expect(gitFetch('/repo', { remoteName: 'fork', branchName: 'keep' })).rejects.toThrow(
      'network unreachable'
    )
  })

  it('normalizes fetch authentication errors to a friendly message', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('Authentication failed'))

    await expect(gitFetch('/repo')).rejects.toThrow(
      'Authentication failed. Check your remote credentials.'
    )
  })
})
