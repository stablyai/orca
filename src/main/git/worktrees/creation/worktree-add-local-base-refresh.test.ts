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

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: translateWslOutputPathsMock
}))

// Keep the ordered runner queues; worktree-checkout-progress-real-git covers the checkout.workers read.
vi.mock('./checkout-workers-git-args', () => ({
  checkoutWorkersGitArgs: async () => []
}))

import { addWorktree } from './worktree-add'
import { registerWorktreeSuiteHooks } from '../testing/worktree-test-harness'

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

  it('still suggests nothing but keeps the warning when the local base ref exists and diverged', async () => {
    queueBehindInspection({ counts: { stdout: '2\t3\n' } })

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    // The only call past the counts is the read-only shallow probe; nothing moves main.
    expect(refreshGitMock.mock.calls).toHaveLength(5)
    expect(refreshGitMock.mock.calls.at(-1)?.[0]).toEqual(['rev-parse', '--is-shallow-repository'])
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
