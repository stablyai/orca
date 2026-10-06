// addWorktree: advisory local-base-ref update suggestions when the refresh setting is off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { addWorktree } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('addWorktree', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    // These branch-safety assertions use POSIX argv; Windows flags have separate coverage.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('suggests updating the local base ref when setting is off and the branch is safely behind', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    expect(result.localBaseRefUpdateSuggestion).toEqual({
      baseRef: 'origin/main',
      localBranch: 'main',
      behind: 2
    })
    expect(gitExecFileAsyncMock.mock.calls.slice(1, 6)).toEqual([
      [['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: '/repo' }],
      [['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [['rev-list', '--left-right', '--count', 'old-main...remote-main'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }]
    ])
    // Advisory only: nothing moves the local branch.
    const commands = gitExecFileAsyncMock.mock.calls.map(([args]) => args)
    expect(commands.some((args) => args.includes('merge') || args[0] === 'update-ref')).toBe(false)
  })

  it('skips advisory owner probes when the local base is already current', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // resolve creation base
      .mockResolvedValueOnce({ stdout: 'same\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'same\n' }) // rev-parse refs/remotes/origin/main^{commit}: current
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // persist branch base
      .mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', false, false, {
        suggestLocalBaseRefUpdate: true
      })
    ).resolves.toEqual({})

    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
      ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/test',
        '/repo-feature',
        'refs/remotes/origin/main'
      ],
      [
        'config',
        '--local',
        '--replace-all',
        'branch.feature/test.base',
        'refs/remotes/origin/main'
      ],
      ['config', '--get', 'push.autoSetupRemote']
    ])
  })

  it('uses normalized branch metadata for slash-containing remotes', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/foo/bar/main^{commit}
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/foo/bar/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'foo/bar/main',
      false,
      false,
      {
        suggestLocalBaseRefUpdate: true,
        remoteTrackingBase: {
          base: 'foo/bar/main',
          branch: 'main',
          ref: 'refs/remotes/foo/bar/main'
        }
      }
    )

    expect(result.localBaseRefUpdateSuggestion).toEqual({
      baseRef: 'foo/bar/main',
      localBranch: 'main',
      behind: 2
    })
    expect(gitExecFileAsyncMock.mock.calls[2]).toEqual([
      ['rev-parse', '--verify', 'refs/remotes/foo/bar/main^{commit}'],
      { cwd: '/repo' }
    ])
  })

  it('does not suggest updating the local base ref when its owner worktree is dirty', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/test',
      'origin/main',
      false,
      false,
      { suggestLocalBaseRefUpdate: true }
    )

    expect(result).toEqual({})
  })
})
