// addWorktree: fast-forwarding the local base ref (reset --hard / update-ref) and its safety bailouts.
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { addWorktree, WORKTREE_ADD_TIMEOUT_MS } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('addWorktree', () => {
  const resolveCreationBaseConfigWrite = () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
  }

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('fast-forwards a checked-out existing branch inside the new worktree (#15645)', async () => {
    // The branch pre-exists locally, is behind origin, and the new worktree just
    // checked it out — so the branch is OWNED by /repo-feature now.
    const worktreeListOutput =
      'worktree /repo\nHEAD aaa111\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD old-tip\nbranch refs/heads/feature\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // worktree add /repo-feature feature
      .mockResolvedValueOnce({ stdout: 'remote-tip\n' }) // resolveWorktreeAddBaseRef existence probe (OID required)
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count (behind only)
      .mockResolvedValueOnce({ stdout: 'old-tip\n' }) // rev-parse refs/heads/feature^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-tip\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo-feature, clean)
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status recheck (still clean)
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard remote-tip (in /repo-feature)

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature',
      'origin/feature',
      true,
      false,
      { checkoutExistingBranch: true }
    )

    expect(result.localBaseRefRefresh).toMatchObject({ status: 'updated' })
    const reset = gitExecFileAsyncMock.mock.calls.find(
      (call) => call[0][0] === 'reset'
    ) as unknown as [string[], { cwd?: string }]
    expect(reset[0]).toEqual(['reset', '--hard', 'remote-tip'])
    expect(reset[1].cwd).toBe('/repo-feature')
  })

  it('skips the no-op reset when the claimed branch is already up to date (#15645)', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // worktree add /repo-feature feature
      .mockResolvedValueOnce({ stdout: 'remote-tip\n' }) // resolveWorktreeAddBaseRef existence probe
      .mockResolvedValueOnce({ stdout: '0\t0\n' }) // rev-list --left-right --count (already current)

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature',
      'origin/feature',
      true,
      false,
      { checkoutExistingBranch: true }
    )

    expect(result.localBaseRefRefresh).toBeUndefined()
    // The common claim: nothing to fast-forward, so no OID resolution, owner probes, or reset --hard.
    expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
      ['worktree', 'add', '/repo-feature', 'feature'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature^{commit}'],
      ['rev-list', '--left-right', '--count', 'refs/heads/feature...refs/remotes/origin/feature']
    ])
  })

  it('leaves a claimed branch with local-only commits silent (#15645)', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // worktree add /repo-feature feature
      .mockResolvedValueOnce({ stdout: 'remote-tip\n' }) // resolveWorktreeAddBaseRef existence probe
      .mockResolvedValueOnce({ stdout: '1\t2\n' }) // rev-list --left-right --count (ahead 1 -> not fast-forwardable)

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature',
      'origin/feature',
      true,
      false,
      { checkoutExistingBranch: true }
    )

    // Claiming a branch you already have commits on is the normal case, not a warning worth an infinite toast.
    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls.find((call) => call[0][0] === 'reset')).toBeUndefined()
  })

  it('surfaces a dirty owner worktree on the claim path (#15645)', async () => {
    // Base is origin/main, so the local counterpart is `main` in the primary repo, not the claimed branch.
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // worktree add /repo-feature feature
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // resolveWorktreeAddBaseRef existence probe
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count (behind only)
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain (in /repo, dirty)

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature',
      'origin/main',
      true,
      false,
      {
        checkoutExistingBranch: true
      }
    )

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(gitExecFileAsyncMock.mock.calls.find((call) => call[0][0] === 'reset')).toBeUndefined()
  })

  it('surfaces a git error on the claim path (#15645)', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD aaa111\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD old-tip\nbranch refs/heads/feature\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // worktree add /repo-feature feature
      .mockResolvedValueOnce({ stdout: 'remote-tip\n' }) // resolveWorktreeAddBaseRef existence probe
      .mockResolvedValueOnce({ stdout: '0\t2\n' }) // rev-list --left-right --count (behind only)
      .mockResolvedValueOnce({ stdout: 'old-tip\n' }) // rev-parse refs/heads/feature^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-tip\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (clean)
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status recheck (clean)
      .mockRejectedValueOnce(new Error('cannot lock ref')) // reset --hard fails

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature',
      'origin/feature',
      true,
      false,
      { checkoutExistingBranch: true }
    )

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/feature',
      localBranch: 'feature'
    })
  })

  it('skips the claim-path refresh for sparse (--no-checkout) creates', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add --no-checkout

    const result = await addWorktree(
      '/repo',
      '/repo-feature',
      'feature',
      'origin/feature',
      true,
      true,
      { checkoutExistingBranch: true }
    )

    // A --no-checkout worktree has an empty index, so probing it would report a bogus dirty status.
    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-checkout', '/repo-feature', 'feature'],
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS }
      ]
    ])
  })

  it('fast-forwards with reset --hard when localBranch is checked out in primary worktree', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/feature\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo)
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain recheck (in /repo)
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard (in /repo)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [
        ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
        { cwd: '/repo' }
      ],
      [['rev-parse', '--verify', 'refs/heads/main^{commit}'], { cwd: '/repo' }],
      [['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], { cwd: '/repo' }],
      [['merge-base', '--is-ancestor', 'old-main', 'remote-main'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }],
      [['reset', '--hard', 'remote-main'], { cwd: '/repo' }],
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

  it('fast-forwards with reset --hard in sibling worktree when localBranch is checked out there', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n\nworktree /repo-main-wt\nHEAD def456\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain recheck (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls[6]).toEqual([
      ['status', '--porcelain', '--untracked-files=no'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
    expect(gitExecFileAsyncMock.mock.calls[8]).toEqual([
      ['status', '--porcelain', '--untracked-files=no'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
    expect(gitExecFileAsyncMock.mock.calls[9]).toEqual([
      ['reset', '--hard', 'remote-main'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
  })

  it('fast-forwards local base via update-ref when localBranch is not checked out', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // update-ref refs/heads/main remote-main old-main
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    // Compare-and-swap form (expected old OID) so a concurrent ref move is a no-op.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
    // No worktree owns the branch, so no working tree is reset.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'reset',
      '--hard',
      'remote-main'
    ])
  })

  it('skips local base refresh when the owner worktree becomes dirty before mutation', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during evaluation
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list before mutation
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain before mutation
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'reset',
      '--hard',
      'refs/heads/main'
    ])
  })

  it('skips local base refresh when the owner worktree switches branches before mutation', async () => {
    const firstWorktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    const secondWorktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: firstWorktreeListOutput }) // worktree list during evaluation
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during evaluation
      .mockResolvedValueOnce({ stdout: secondWorktreeListOutput }) // worktree list before mutation
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'reset',
      '--hard',
      'refs/heads/main'
    ])
  })

  it('skips local base refresh when owner revalidation cannot list worktrees', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list during evaluation
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain during evaluation
      .mockRejectedValueOnce(new Error('worktree list failed')) // worktree list before mutation
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).not.toContainEqual([
      'update-ref',
      'refs/heads/main',
      'remote-main',
      'old-main'
    ])
  })

  it('skips update when the owning worktree is dirty', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse remote tracking ref^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain (dirty)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_dirty_worktree',
      baseRef: 'origin/main',
      localBranch: 'main',
      ownerWorktreePath: '/repo'
    })

    // No reset --hard or update-ref — just base resolution, drift check, local/remote
    // OIDs, ancestry check, worktree list, status, worktree add, and config writes.
    expect(gitExecFileAsyncMock.mock.calls).toHaveLength(11)
    expect(gitExecFileAsyncMock.mock.calls[0]?.[0]).toEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main^{commit}'
    ])
    expect(gitExecFileAsyncMock.mock.calls[7]?.[0]).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'feature/test',
      '/repo-feature',
      'refs/remotes/origin/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[8]?.[0]).toEqual([
      'config',
      '--local',
      '--replace-all',
      'branch.feature/test.base',
      'refs/remotes/origin/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[9]?.[0]).toEqual([
      'config',
      '--get',
      'push.autoSetupRemote'
    ])
    expect(gitExecFileAsyncMock.mock.calls[10]?.[0]).toEqual([
      'config',
      '--local',
      'push.autoSetupRemote',
      'true'
    ])
  })

  it('skips updating the local branch when it has diverged', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not a fast-forward'))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // for-each-ref refs/heads/main (exists)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
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
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--get', 'push.autoSetupRemote'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--local', 'push.autoSetupRemote', 'true'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ]
    ])
  })

  // #15331: evaluation runs before `-b <branch>` exists, so rev-list fails on the missing local ref.
  it('does not warn when worktree add itself creates the local base branch', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/feature-x^{commit}
      .mockRejectedValueOnce(
        new Error(
          "fatal: ambiguous argument 'refs/heads/feature-x...refs/remotes/origin/feature-x': unknown revision or path not in the working tree."
        )
      ) // rev-list: refs/heads/feature-x does not exist yet
      .mockResolvedValueOnce({ stdout: '' }) // for-each-ref refs/heads/feature-x (missing)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

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
    // Nothing was refreshed, so no ref mutation.
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])).not.toContain('update-ref')
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0][0])).not.toContain('reset')
  })

  // #15331: same missing-local-branch class, but the new branch name differs from the base's.
  it('does not warn when the local base branch does not exist in a fetch-only clone', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/main^{commit}
      .mockRejectedValueOnce(new Error('unknown revision refs/heads/main')) // rev-list: no local main
      .mockResolvedValueOnce({ stdout: '' }) // for-each-ref refs/heads/main (missing)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toBeUndefined()
    expect(gitExecFileAsyncMock.mock.calls.map((call) => call[0])).toContainEqual([
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      'refs/heads/main'
    ])
  })

  // A failed probe is not proof of absence, so the warning must survive it.
  it('keeps the warning when the local base ref probe itself fails', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/main^{commit}
      .mockRejectedValueOnce(new Error('rev-list failed')) // drift probe
      .mockRejectedValueOnce(new Error('fatal: not a git repository')) // for-each-ref probe could not run
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
  })

  it('still suggests nothing but keeps the warning when the local base ref exists and diverged', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/main^{commit}
      .mockResolvedValueOnce({ stdout: '2\t3\n' }) // rev-list: 2 local-only commits
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'main', 'origin/main', true)

    // Same branch name as the base, but rev-list succeeded: real divergence must still warn.
    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
  })

  it('skips local base refresh when captured OIDs are no longer ancestor-safe', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/origin/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '0\t2\n' }) // stale rev-list result
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'new-local\n' }) // rev-parse refs/heads/main^{commit}
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'remote-main\n' }) // rev-parse refs/remotes/origin/main^{commit}
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not an ancestor')) // merge-base captured OIDs
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'refs/heads/main\n' }) // for-each-ref refs/heads/main (exists)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    resolveCreationBaseConfigWrite()
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['rev-list', '--left-right', '--count', 'refs/heads/main...refs/remotes/origin/main'],
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
        ['merge-base', '--is-ancestor', 'new-local', 'remote-main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/heads/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
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
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        [
          'config',
          '--local',
          '--replace-all',
          'branch.feature/test.base',
          'refs/remotes/origin/main'
        ],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--get', 'push.autoSetupRemote'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--local', 'push.autoSetupRemote', 'true'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ]
    ])
  })

  it('uses the remote name from the base ref instead of hardcoding origin', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/remotes/upstream/main^{commit}
      .mockResolvedValueOnce({ stdout: '0\t3\n' }) // rev-list --left-right --count
      .mockResolvedValueOnce({ stdout: 'old-main\n' }) // rev-parse refs/heads/main^{commit}
      .mockResolvedValueOnce({ stdout: 'remote-upstream-main\n' }) // rev-parse refs/remotes/upstream/main^{commit}
      .mockResolvedValueOnce({ stdout: '' }) // merge-base captured OIDs
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list recheck
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain recheck
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockResolvedValueOnce({ stdout: '' }) // config --local --replace-all branch.<branch>.base
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'upstream/main', true)

    expect(gitExecFileAsyncMock.mock.calls[1]?.[0]).toEqual([
      'rev-list',
      '--left-right',
      '--count',
      'refs/heads/main...refs/remotes/upstream/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[9]?.[0]).toEqual([
      'reset',
      '--hard',
      'remote-upstream-main'
    ])
  })
})
