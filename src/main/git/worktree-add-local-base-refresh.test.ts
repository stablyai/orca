import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  refreshGitMock,
  checkoutGitMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  refreshGitMock: vi.fn(),
  checkoutGitMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output)
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { addWorktree, WORKTREE_ADD_TIMEOUT_MS } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('addWorktree', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    // These branch-safety assertions use POSIX argv; Windows flags have separate coverage.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    // Separate the overlapping checkout from the ordered refresh probe queue.
    refreshGitMock.mockReset()
    checkoutGitMock.mockReset().mockImplementation(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        throw Object.assign(new Error('key unset'), { code: 1 })
      }
      return { stdout: '' }
    })
    gitExecFileAsyncMock
      .mockReset()
      .mockImplementation((args: string[], opts: unknown) =>
        (args[0] === 'worktree' && args[1] === 'add') ||
        args[0] === 'config' ||
        (args[0] === 'branch' && args[1] === '--set-upstream-to')
          ? checkoutGitMock(args, opts)
          : refreshGitMock(args, opts)
      )
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('fast-forwards with merge --ff-only when localBranch is checked out in primary worktree', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/feature\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'remote-main\n' })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(refreshGitMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: '/repo' }],
      [['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [['rev-list', '--left-right', '--count', 'old-main...remote-main'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }],
      [['symbolic-ref', '-q', 'HEAD'], { cwd: '/repo' }],
      [ownerFastForwardArgs('remote-main'), { cwd: '/repo' }],
      [['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: '/repo' }]
    ])
    expect(checkoutGitMock.mock.calls).toEqual([
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

  it('runs worktree add while the local base refresh is still fast-forwarding', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    let finishMerge!: () => void
    let markMergeStarted!: () => void
    const mergeStarted = new Promise<void>((resolve) => {
      markMergeStarted = resolve
    })
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMerge = () => resolve({ stdout: '' })
            markMergeStarted()
          })
      )
      .mockResolvedValueOnce({ stdout: 'remote-main\n' })
    checkoutGitMock.mockImplementationOnce(async () => {
      await mergeStarted
      finishMerge()
      return { stdout: '' }
    })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(checkoutGitMock.mock.calls[0]?.[0]).toContain('add')
  })

  it('fast-forwards in the sibling worktree when localBranch is checked out there', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n\nworktree /repo-main-wt\nHEAD def456\nbranch refs/heads/main\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'remote-main\n' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(refreshGitMock.mock.calls.slice(5)).toEqual([
      [
        ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
        expect.objectContaining({ cwd: '/repo-main-wt' })
      ],
      [['symbolic-ref', '-q', 'HEAD'], expect.objectContaining({ cwd: '/repo-main-wt' })],
      [ownerFastForwardArgs('remote-main'), expect.objectContaining({ cwd: '/repo-main-wt' })],
      [
        ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ]
    ])
  })

  it('fast-forwards local base via update-ref when localBranch is not checked out', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(refreshGitMock.mock.calls.at(-1)).toEqual([
      [
        'update-ref',
        '-m',
        'orca: fast-forward to refs/remotes/origin/main',
        'refs/heads/main',
        'remote-main',
        'old-main'
      ],
      { cwd: '/repo' }
    ])
    expect(refreshGitMock.mock.calls.map(([args]) => args)).not.toContainEqual(
      ownerFastForwardArgs('remote-main')
    )
  })

  it('reports the owner dirty when the fast-forward refuses to overwrite an edit made after inspection', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: git merge'), {
          stderr:
            'error: Your local changes to the following files would be overwritten by merge:\n\tpackage.json'
        })
      )
      .mockRejectedValueOnce(Object.assign(new Error('not ancestor'), { code: 1 })) // merge-base

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(refreshGitMock.mock.calls.at(-1)).toEqual([
      ['merge-base', '--is-ancestor', 'remote-main', 'refs/heads/main'],
      expect.objectContaining({ cwd: '/repo' })
    ])
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args[0])).not.toContain('update-ref')
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args[0])).not.toContain('reset')
  })

  it('skips local base refresh when the owner worktree switches branches before mutation', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/develop\n' })
      .mockRejectedValueOnce(Object.assign(new Error('not ancestor'), { code: 1 })) // merge-base

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).not.toContainEqual(
      ownerFastForwardArgs('remote-main')
    )
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args[0])).not.toContain('update-ref')
  })

  it('skips local base refresh when worktree ownership cannot be listed', async () => {
    queueBehindInspection().mockRejectedValueOnce(new Error('worktree list failed'))

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(refreshGitMock.mock.calls.map(([args]) => args[0])).toEqual([
      'rev-parse',
      'rev-parse',
      'rev-parse',
      'rev-list',
      'worktree'
    ])
  })

  it('skips update when the owning worktree is dirty', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: ' M package.json\n' })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })

    expect(refreshGitMock.mock.calls).toHaveLength(6)
    expect(refreshGitMock.mock.calls[0]?.[0]).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main^{commit}'
    ])
    expect(checkoutGitMock.mock.calls.map((call) => call[0])).toEqual([
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
      ['config', '--get', 'push.autoSetupRemote'],
      ['config', '--local', 'push.autoSetupRemote', 'true']
    ])
  })

  it('skips updating the local branch when its drift probe fails but the branch exists', async () => {
    queueBehindInspection({ counts: new Error('not a fast-forward') }).mockResolvedValueOnce({
      stdout: ''
    })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(refreshGitMock.mock.calls).toEqual([
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-list', '--left-right', '--count', 'old-main...remote-main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['show-ref', '--verify', '--quiet', '--', 'refs/heads/main'],
        expect.objectContaining({ cwd: '/repo' })
      ]
    ])
    expect(checkoutGitMock.mock.calls.map((call) => call[0][0])).toEqual([
      'worktree',
      'config',
      'config',
      'config'
    ])
  })

  // Creating the base's own local branch leaves nothing to refresh; probing would race the add.
  it('does not warn when worktree add itself creates the local base branch', async () => {
    refreshGitMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' })
      .mockRejectedValueOnce(
        new Error(
          "fatal: ambiguous argument 'refs/heads/feature-x...refs/remotes/origin/feature-x': unknown revision or path not in the working tree."
        )
      )
      .mockResolvedValueOnce({ stdout: '' })

    const result = await addWorktree(
      '/repo',
      '/repo-feature-x',
      'feature-x',
      'origin/feature-x',
      true
    )

    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'feature-x',
      '/repo-feature-x',
      'refs/remotes/origin/feature-x'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'branch',
      '--set-upstream-to',
      'refs/remotes/origin/feature-x',
      'feature-x'
    ])
    expect(refreshGitMock.mock.calls.map((call) => call[0][0])).toEqual(['rev-parse'])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])).not.toContain('update-ref')
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])).not.toContain('reset')
  })

  it('does not warn when the local base branch does not exist in a fetch-only clone', async () => {
    refreshGitMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' })
      .mockRejectedValueOnce(new Error('unknown revision refs/heads/main'))
      .mockRejectedValueOnce(Object.assign(new Error('missing ref'), { code: 1 }))

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(refreshGitMock.mock.calls.at(-1)?.[0]).toEqual([
      'show-ref',
      '--verify',
      '--quiet',
      '--',
      'refs/heads/main'
    ])
  })

  it('keeps the warning when the local base ref probe itself fails', async () => {
    refreshGitMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' })
      .mockRejectedValueOnce(new Error('rev-parse failed')) // local oid probe
      .mockRejectedValueOnce(new Error('fatal: not a git repository'))

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
  })

  it('still suggests nothing but keeps the warning when the local base ref exists and diverged', async () => {
    queueBehindInspection({ counts: { stdout: '2\t3\n' } })

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(refreshGitMock.mock.calls).toHaveLength(4)
  })

  it('reports not-fast-forward when local gained a commit after the inspection', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: git merge'), {
          stderr: 'fatal: Not possible to fast-forward, aborting.'
        })
      )
      .mockRejectedValueOnce(Object.assign(new Error('not ancestor'), { code: 1 })) // merge-base

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args[0])).not.toContain('reset')
  })

  it('uses the remote name from the base ref instead of hardcoding origin', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    queueBehindInspection({ remoteOid: 'remote-upstream-main' })
      .mockResolvedValueOnce({ stdout: worktreeListOutput })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'remote-upstream-main\n' })

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'upstream/main', true)

    expect(refreshGitMock.mock.calls[2]?.[0]).toEqual([
      'rev-parse',
      '--verify',
      'refs/remotes/upstream/main^{commit}'
    ])
    expect(refreshGitMock.mock.calls[3]?.[0]).toEqual([
      'rev-list',
      '--left-right',
      '--count',
      'old-main...remote-upstream-main'
    ])
    expect(refreshGitMock.mock.calls[7]?.[0]).toEqual(ownerFastForwardArgs('remote-upstream-main'))
  })
})

function ownerFastForwardArgs(remoteOid: string): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'merge.autoStash=false',
    '-c',
    'branch.main.mergeOptions=',
    'merge',
    '--ff-only',
    '-s',
    'recursive',
    '--no-verify-signatures',
    '--no-overwrite-ignore',
    '--no-stat',
    '-q',
    remoteOid
  ]
}

function queueBehindInspection(
  options: { remoteOid?: string; counts?: { stdout: string } | Error } = {}
) {
  const counts = options.counts ?? { stdout: '0\t3\n' }
  refreshGitMock
    .mockResolvedValueOnce({ stdout: 'abc123\n' })
    .mockResolvedValueOnce({ stdout: 'old-main\n' })
    .mockResolvedValueOnce({ stdout: `${options.remoteOid ?? 'remote-main'}\n` })
  return counts instanceof Error
    ? refreshGitMock.mockRejectedValueOnce(counts)
    : refreshGitMock.mockResolvedValueOnce(counts)
}
