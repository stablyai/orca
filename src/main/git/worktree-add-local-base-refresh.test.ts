// addWorktree: fast-forwarding the local base ref (merge --ff-only / update-ref) and its safety bailouts.
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
    // The refresh overlaps `worktree add`, so checkout calls get a fixed fake and the
    // (sequential) base-resolution + refresh calls keep their own ordered queue.
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
        (args[0] === 'worktree' && args[1] === 'add') || args[0] === 'config'
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
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo)
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // symbolic-ref -q HEAD (in /repo)
      .mockResolvedValueOnce({ stdout: '' }) // merge --ff-only (in /repo)
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/heads/main after the merge

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
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // symbolic-ref -q HEAD
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMerge = () => resolve({ stdout: '' })
            markMergeStarted()
          })
      ) // merge --ff-only, held until worktree add is running
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/heads/main after the merge
    // Would deadlock if the create awaited the refresh before starting the add.
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
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // symbolic-ref (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: '' }) // merge --ff-only (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/heads/main after the merge

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(refreshGitMock.mock.calls.slice(5)).toEqual([
      [
        ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
        expect.objectContaining({ cwd: '/repo-main-wt' })
      ],
      [['symbolic-ref', '-q', 'HEAD'], expect.objectContaining({ cwd: '/repo-main-wt' })],
      [ownerFastForwardArgs('remote-main'), expect.objectContaining({ cwd: '/repo-main-wt' })],
      // Confirms local landed exactly on the target, read from the repo like the inspection.
      [
        ['rev-parse', '--verify', 'refs/heads/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ]
    ])
  })

  it('fast-forwards local base via update-ref when localBranch is not checked out', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // update-ref refs/heads/main remote-main old-main

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    // Compare-and-swap form (expected old OID) so a concurrent ref move is a no-op.
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
    // No worktree owns the branch, so no working tree is touched.
    expect(refreshGitMock.mock.calls.map(([args]) => args)).not.toContainEqual(
      ownerFastForwardArgs('remote-main')
    )
  })

  it('reports the owner dirty when the fast-forward refuses to overwrite an edit made after inspection', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during inspection
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // symbolic-ref -q HEAD
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: git merge'), {
          stderr:
            'error: Your local changes to the following files would be overwritten by merge:\n\tpackage.json'
        })
      ) // merge --ff-only refuses
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
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list during inspection
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during inspection
      .mockResolvedValueOnce({ stdout: 'refs/heads/develop\n' }) // symbolic-ref: owner switched
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
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain (dirty)

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })

    // No merge or update-ref: just base resolution, local/remote OIDs, drift count, worktree
    // list and the owner status.
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
    }) // show-ref refs/heads/main (exists)

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

  // #15331: `-b feature-x` proves there was no local feature-x to refresh. The add overlaps the
  // refresh, so a probe could see the branch absent and then present (the add just wrote it).
  it('does not warn when worktree add itself creates the local base branch', async () => {
    refreshGitMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/feature-x^{commit}
      .mockRejectedValueOnce(
        new Error(
          "fatal: ambiguous argument 'refs/heads/feature-x...refs/remotes/origin/feature-x': unknown revision or path not in the working tree."
        )
      ) // rev-list, if it ran: refs/heads/feature-x not written yet
      .mockResolvedValueOnce({ stdout: '' }) // show-ref, if it ran: the concurrent add has written it

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
    // No refresh probe raced the add, and nothing was mutated.
    expect(refreshGitMock.mock.calls.map((call) => call[0][0])).toEqual(['rev-parse'])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])).not.toContain('update-ref')
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])).not.toContain('reset')
  })

  // #15331: same missing-local-branch class, but the new branch name differs from the base's.
  it('does not warn when the local base branch does not exist in a fetch-only clone', async () => {
    refreshGitMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/main^{commit}
      .mockRejectedValueOnce(new Error('unknown revision refs/heads/main')) // rev-parse: no local main
      .mockRejectedValueOnce(Object.assign(new Error('missing ref'), { code: 1 })) // show-ref refs/heads/main (missing)

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

  // A failed probe is not proof of absence, so the warning must survive it.
  it('keeps the warning when the local base ref probe itself fails', async () => {
    refreshGitMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/main^{commit}
      .mockRejectedValueOnce(new Error('rev-parse failed')) // local oid probe
      .mockRejectedValueOnce(new Error('fatal: not a git repository')) // show-ref probe could not run

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
  })

  it('still suggests nothing but keeps the warning when the local base ref exists and diverged', async () => {
    queueBehindInspection({ counts: { stdout: '2\t3\n' } }) // rev-list: 2 local-only commits

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    // Local main exists with local-only commits: real divergence must still warn.
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
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // symbolic-ref -q HEAD
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: git merge'), {
          stderr: 'fatal: Not possible to fast-forward, aborting.'
        })
      ) // merge --ff-only refuses to drop the new commit
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
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // symbolic-ref -q HEAD
      .mockResolvedValueOnce({ stdout: '' }) // merge --ff-only
      .mockResolvedValueOnce({ stdout: 'remote-upstream-main\n' }) // rev-parse refs/heads/main after the merge

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

/** Queues base resolution plus the inspection's local oid, remote oid and drift count. */
function queueBehindInspection(
  options: { remoteOid?: string; counts?: { stdout: string } | Error } = {}
) {
  const counts = options.counts ?? { stdout: '0\t3\n' }
  refreshGitMock
    .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet <remote-tracking>^{commit}
    .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse --verify refs/heads/main^{commit}
    .mockResolvedValueOnce({ stdout: `${options.remoteOid ?? 'remote-main'}\n` }) // rev-parse --verify <remote-tracking>^{commit}
  return counts instanceof Error
    ? refreshGitMock.mockRejectedValueOnce(counts)
    : refreshGitMock.mockResolvedValueOnce(counts)
}
