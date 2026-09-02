// addWorktree: checkout creation, branch-base/push.autoSetupRemote config writes, ref qualification.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  moveWorktreeDirectoryToTrashMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  moveWorktreeDirectoryToTrashMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

// Default: the checkout cannot be renamed aside, so removal deletes it in place.
vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { addSparseWorktree, addWorktree, WORKTREE_ADD_TIMEOUT_MS } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('addWorktree', () => {
  const resolveRemoteBase = () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
  }

  const resolveCreationBaseConfigWrite = () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
  }

  // Why: argv now depends on the host OS, so pin a non-Windows default or every
  // exact-argv assertion below would fail for a maintainer running vitest on Windows.
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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

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
    // Why: a C:\ cwd can be served by host git.exe even with wslDistro set, and that
    // is exactly the MAX_PATH-prone case; Linux git parses and ignores the key.
    platformSpy.mockReturnValue('win32')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

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
      gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

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
    // Why: without a timeout, a OneDrive cloud-placeholder checkout can stall
    // `git worktree add` for minutes. Assert the runner receives a non-zero
    // timeout so a stuck create fails fast instead of hanging forever.
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
      checkoutExistingBranch: true
    })

    const worktreeAddCall = gitExecFileAsyncMock.mock.calls.find(
      ([argv]) => Array.isArray(argv) && argv[0] === 'worktree' && argv[1] === 'add'
    )
    expect(worktreeAddCall?.[1]).toMatchObject({ timeout: WORKTREE_ADD_TIMEOUT_MS })
    expect(WORKTREE_ADD_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('raises the worktree add timeout from ORCA_WORKTREE_ADD_TIMEOUT_MS (#12696)', async () => {
    vi.stubEnv('ORCA_WORKTREE_ADD_TIMEOUT_MS', '600000')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
      checkoutExistingBranch: true
    })

    const worktreeAddCall = gitExecFileAsyncMock.mock.calls.find(
      ([argv]) => Array.isArray(argv) && argv[0] === 'worktree' && argv[1] === 'add'
    )
    expect(worktreeAddCall?.[1]).toMatchObject({ timeout: 600_000 })
  })

  it('does not write branch base config when no base branch is provided', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set

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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('config locked')) // config --local --replace-all branch.<branch>.base
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local --unset-all branch.<branch>.base
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set
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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get (unset, expected)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('config locked')) // config --local set fails
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
    // Why: exit 1 from `git config --get` means "key unset" — anything else
    // is a real read failure (parse error, locked file). We must NOT fall
    // through to `--local set true`, which would silently overwrite whatever
    // value the user actually has.
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
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
    // No --local set was attempted: only worktree add + the failing --get.
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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'false\n' }) // config --get returns existing value

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    // No --local set: --get succeeded so we preserve the user's value.
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
    // Why: `git config --get key` exits 0 if the key has any value at any
    // scope, including the unusual case of an explicitly empty string. We
    // must not fall through to `--local set true` and overwrite that.
    resolveRemoteBase()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --get succeeds with empty value

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
    // Why: a refactor that moves the config block earlier could try to write
    // push.autoSetupRemote against a worktree directory that was never
    // created. Pin the current ordering invariant: config calls happen only
    // after worktree add succeeds.
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
    // Why: repos that fetch with --tags can end up with a local tag named 'main',
    // making `git worktree add ... main` fail with "fatal: Ambiguous object name".
    // Qualifying as refs/heads/main tells git exactly which object to use.
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

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

  it('qualifies slash-containing local branch names when no remote ref matches', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('no remote ref')) // rev-parse refs/remotes/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/release', 'release/main')

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

  it('does not report a local base refresh for slash-containing local branch names', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('no remote ref')) // rev-parse refs/remotes/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/release/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

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
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'true\n' }) // push.autoSetupRemote already set
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('sparse setup failed')) // sparse-checkout init
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local --unset-all branch.<branch>.base
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: beforeRemoval }) // worktree list before remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree remove
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // branch -D (rollback force-deletes the fresh branch)

    await expect(
      addSparseWorktree('/repo', '/repo-feature', 'feature/test', ['src'], 'origin/main')
    ).rejects.toThrow('sparse setup failed')

    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'config',
      '--local',
      '--unset-all',
      'branch.feature/test.base'
    ])
    // Why: rolling back a failed creation force-deletes the just-created branch
    // (`-D`) — it has no user commits to protect, unlike a user-initiated delete.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'branch',
      '-D',
      '--',
      'feature/test'
    ])
  })
})
