import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

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

import { addSparseWorktree, addWorktree, WORKTREE_ADD_TIMEOUT_MS } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('addWorktree', () => {
  const resolveRemoteBase = () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' })
  }

  const resolveCreationBaseConfigWrite = () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
  }

  // Pin non-Windows argv; Windows creation adds platform-specific flags.
  let platformSpy: MockInstance<() => NodeJS.Platform>

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    platformSpy.mockRestore()
  })

  it('creates the worktree without touching the local base ref by default', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }],
      [['config', '--local', 'push.autoSetupRemote', 'true'], { cwd: '/repo-feature' }]
    ])
  })

  it('checks out a selected existing local branch without creating a new branch', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
      checkoutExistingBranch: true
    })

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '/repo-feature', 'feature/test'],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ]
    ])
  })

  it('enables long paths for native Windows worktree creation', async () => {
    platformSpy.mockReturnValue('win32')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree(
      'C:\\repo',
      'C:\\repo-feature',
      'feature/test',
      'feature/test',
      false,
      false,
      { checkoutExistingBranch: true }
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['-c', 'core.longpaths=true', 'worktree', 'add', 'C:\\repo-feature', 'feature/test'],
      { cwd: 'C:\\repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
    )
  })

  it('still enables long paths for a Windows-path repo that has a WSL distro configured', async () => {
    // Host Git may serve C: paths even with a WSL distro; Linux Git ignores core.longpaths.
    platformSpy.mockReturnValue('win32')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree(
      'C:\\repo',
      'C:\\repo-feature',
      'feature/test',
      'feature/test',
      false,
      false,
      { checkoutExistingBranch: true, wslDistro: 'Ubuntu' }
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['-c', 'core.longpaths=true', 'worktree', 'add', 'C:\\repo-feature', 'feature/test'],
      { cwd: 'C:\\repo', wslDistro: 'Ubuntu', timeout: WORKTREE_ADD_TIMEOUT_MS }
    )
  })

  it('does not pass the Windows-only long-path option for a WSL UNC repo path', async () => {
    platformSpy.mockReturnValue('win32')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    const repoPath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
    await addWorktree(
      repoPath,
      '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-feature',
      'feature/test',
      'feature/test',
      false,
      false,
      { checkoutExistingBranch: true, wslDistro: 'Ubuntu' }
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['worktree', 'add', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo-feature', 'feature/test'],
      { cwd: repoPath, wslDistro: 'Ubuntu', timeout: WORKTREE_ADD_TIMEOUT_MS }
    )
  })

  it.each(['darwin', 'linux'] as const)(
    'does not pass the long-path option on %s',
    async (platform) => {
      platformSpy.mockReturnValue(platform)
      gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

      await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
        checkoutExistingBranch: true
      })

      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['worktree', 'add', '/repo-feature', 'feature/test'],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      )
    }
  )

  it('bounds the worktree add call with a positive timeout (STA-1292 OneDrive stall guard)', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
      checkoutExistingBranch: true
    })

    const worktreeAddCall = gitExecFileAsyncMock.mock.calls.find(
      ([argv]) => Array.isArray(argv) && argv.includes('worktree') && argv.includes('add')
    )
    expect(worktreeAddCall?.[1]).toMatchObject({ timeout: WORKTREE_ADD_TIMEOUT_MS })
    expect(WORKTREE_ADD_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('raises the worktree add timeout from ORCA_WORKTREE_ADD_TIMEOUT_MS (#12696)', async () => {
    vi.stubEnv('ORCA_WORKTREE_ADD_TIMEOUT_MS', '600000')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
      checkoutExistingBranch: true
    })

    const worktreeAddCall = gitExecFileAsyncMock.mock.calls.find(
      ([argv]) => Array.isArray(argv) && argv.includes('worktree') && argv.includes('add')
    )
    expect(worktreeAddCall?.[1]).toMatchObject({ timeout: 600_000 })
  })

  it('does not write branch base config when no base branch is provided', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' })

    await addWorktree('/repo', '/repo-feature', 'feature/no-base')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/no-base', '/repo-feature'],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('warns and unsets stale branch base config when persisting the base fails', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('config locked'))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toEqual({})

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set branch.feature/test.base for /repo-feature',
      expect.any(Error)
    )
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
    warnSpy.mockRestore()
  })

  it('warns but does not throw when push.autoSetupRemote config fails', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 }))
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('config locked'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toEqual({})

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set push.autoSetupRemote for /repo-feature',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('warns and skips --local set when --get fails with non-unset error (e.g. corrupt config)', async () => {
    // Only exit 1 means unset; other read failures must preserve the user's config.
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('parse error'), { code: 3 })) // --get fails non-unset
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toEqual({})

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set push.autoSetupRemote for /repo-feature',
      expect.any(Error)
    )
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
    warnSpy.mockRestore()
  })

  it('preserves existing push.autoSetupRemote value (does not overwrite user-set false)', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'false\n' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('treats --get success with empty stdout as "already set" (key present but blank)', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo-feature' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('does not write config when worktree add itself fails', async () => {
    resolveRemoteBase()
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('worktree add failed'))

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).rejects.toThrow('worktree add failed')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        [
          'worktree',
          'add',
          '--no-track',
          '-b',
          'feature/test',
          '/repo-feature',
          'refs/remotes/origin/main'
        ],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ]
    ])
  })

  it('qualifies bare branch name as refs/heads/ when a same-named tag exists', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await addWorktree('/repo', '/repo-feature', 'feature/disambig', 'main')

    expect(gitExecFileAsyncMock.mock.calls[0]).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'],
      { cwd: '/repo' }
    ])
    expect(gitExecFileAsyncMock.mock.calls[1]).toEqual([
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/disambig',
        '/repo-feature',
        'refs/heads/main'
      ],
      { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
    ])
  })

  it('does not report a local base refresh for slash-containing local branch names', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('no remote ref'))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 }))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature/release',
      'release/main',
      true
    )

    expect(result).toEqual({})
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toEqual([
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/release/main^{commit}'],
      ['rev-parse', '--verify', '--quiet', 'refs/heads/release/main^{commit}'],
      [
        'worktree',
        'add',
        '--no-track',
        '-b',
        'feature/release',
        '/repo-feature',
        'refs/heads/release/main'
      ],
      [
        'config',
        '--local',
        '--replace-all',
        'branch.feature/release.base',
        'refs/heads/release/main'
      ],
      ['config', '--get', 'push.autoSetupRemote'],
      ['config', '--local', 'push.autoSetupRemote', 'true']
    ])
  })

  it('unsets branch base config during sparse setup cleanup after creation succeeds', async () => {
    const beforeRemoval =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n'
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' })
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('sparse setup failed'))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(
      addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['src'], 'origin/main')
    ).rejects.toThrow('sparse setup failed')

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
    // Rollback may force-delete its new branch; user-initiated deletion must protect commits.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'branch',
      '-D',
      '--',
      'feature/test'
    ])
  })
})
