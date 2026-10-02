import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../shared/execution-host'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  assertNoPendingWorktreeRemovalConflict,
  finishAcceptedWorktreeRemoval,
  projectPendingWorktreeRemovals,
  removesInBackground,
  snapshotPendingWorktreeRemovals,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from './worktree-background-removal'

const removal = {
  worktreeId: 'repo-1::/work/feature',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktree: { path: '/work/feature', branch: 'refs/heads/feature', head: 'abc' },
  deleteBranch: true,
  force: false
}
const isPending = (hostId?: ExecutionHostId): boolean =>
  waitForPendingWorktreeRemoval(removal.worktreeId, hostId) !== undefined

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('background worktree removal', () => {
  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
  })

  it('resolves with the delete result once Git finishes, after the row has left the table', async () => {
    const git = deferred<{ preservedBranch: { branchName: string; head: string } }>()
    const pendingAtPublish: boolean[] = []
    const result = startBackgroundWorktreeRemoval({
      removal,
      run: () => git.promise,
      publish: () => pendingAtPublish.push(isPending())
    })

    expect(isPending()).toBe(true)
    expect(pendingAtPublish).toEqual([true])

    git.resolve({ preservedBranch: { branchName: 'feature', head: 'abc' } })
    await expect(result).resolves.toEqual({
      preservedBranch: { branchName: 'feature', head: 'abc' }
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
    // A refetch the end notice triggers must not see the row as still removing.
    expect(pendingAtPublish).toEqual([true, false])
  })

  it('gives a request that joins a running delete that delete’s result', async () => {
    const git = deferred<{ preservedBranch: { branchName: string; head: string } }>()
    const run = vi.fn(() => git.promise)
    void startBackgroundWorktreeRemoval({ removal, run, publish: () => {} })

    const joined = finishAcceptedWorktreeRemoval(
      { removing: true, warning: 'hook skipped' },
      removal.worktreeId
    )
    git.resolve({ preservedBranch: { branchName: 'feature', head: 'abc' } })

    await expect(joined).resolves.toEqual({
      warning: 'hook skipped',
      preservedBranch: { branchName: 'feature', head: 'abc' }
    })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('answers a request whose delete a concurrent removal of the same worktree replaced', async () => {
    // The desktop IPC and runtime RPC removal paths coalesce separately, so both can be accepted.
    const first = deferred<Record<string, never>>()
    const second = deferred<{ preservedBranch: { branchName: string; head: string } }>()
    const firstResult = startBackgroundWorktreeRemoval({
      removal,
      run: () => first.promise,
      publish: () => {}
    })
    const secondResult = startBackgroundWorktreeRemoval({
      removal,
      run: () => second.promise,
      publish: () => {}
    })

    first.resolve({})
    await expect(firstResult).resolves.toEqual({})
    expect(isPending()).toBe(true)

    second.resolve({ preservedBranch: { branchName: 'feature', head: 'abc' } })
    await expect(secondResult).resolves.toEqual({
      preservedBranch: { branchName: 'feature', head: 'abc' }
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
  })

  it('rejects with the delete error and clears the row so a retry starts over', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        throw new Error('Failed to delete worktree at /work/feature. Permission denied')
      },
      publish: () => {}
    })
    await expect(result).rejects.toThrow('Permission denied')
    await _settlePendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
  })

  it('keeps the table consistent when publishing throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    void startBackgroundWorktreeRemoval({
      removal,
      run: async () => ({}),
      publish: () => {
        throw new Error('window gone')
      }
    })
    await _settlePendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
  })

  it('refuses a create at the same path or branch while Git deletes', async () => {
    const git = deferred<Record<string, never>>()
    void startBackgroundWorktreeRemoval({
      removal,
      run: () => git.promise,
      publish: () => {}
    })

    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { worktreePath: '/work/feature' })
    ).toThrow('Cleanup is pending; try again shortly.')
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { branch: 'refs/heads/feature' })
    ).toThrow('Cleanup is pending; try again shortly.')
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/other-repo', { branch: 'feature' })
    ).not.toThrow()
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', {
        worktreePath: '/work/feature-2',
        branch: 'feature-2'
      })
    ).not.toThrow()

    git.resolve({})
    await _settlePendingWorktreeRemovalsForTests()
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { worktreePath: '/work/feature' })
    ).not.toThrow()
  })

  it('answers only for this host: a same-id row on an SSH host is not being removed here', () => {
    void startBackgroundWorktreeRemoval({
      removal,
      run: () => new Promise(() => {}),
      publish: () => {}
    })
    expect(isPending('local')).toBe(true)
    expect(isPending('ssh:box')).toBe(false)
  })

  it('marks rows for clients that read the marker and omits them for clients that do not', () => {
    void startBackgroundWorktreeRemoval({
      removal,
      run: () => new Promise(() => {}),
      publish: () => {}
    })
    const rows = [
      { id: removal.worktreeId, hostId: 'local' as const },
      { id: 'repo-1::/work/other' },
      { id: removal.worktreeId, hostId: 'ssh:box' as const }
    ]

    expect(
      projectPendingWorktreeRemovals(rows, (row) => row.id, true, snapshotPendingWorktreeRemovals())
    ).toEqual([
      { id: removal.worktreeId, hostId: 'local', removing: true },
      { id: 'repo-1::/work/other' },
      { id: removal.worktreeId, hostId: 'ssh:box' }
    ])
    expect(
      projectPendingWorktreeRemovals(
        rows,
        (row) => row.id,
        false,
        snapshotPendingWorktreeRemovals()
      )
    ).toEqual([{ id: 'repo-1::/work/other' }, { id: removal.worktreeId, hostId: 'ssh:box' }])
  })

  it('drops a row a listing read before Git finished deleting it, and keeps one whose delete failed', async () => {
    const other = { ...removal, worktreeId: 'repo-1::/work/other' }
    const removed = deferred<Record<string, never>>()
    const failed = deferred<Record<string, never>>()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    void startBackgroundWorktreeRemoval({ removal, run: () => removed.promise, publish: () => {} })
    void startBackgroundWorktreeRemoval({
      removal: other,
      run: async () => {
        await failed.promise
        throw new Error('git failed')
      },
      publish: () => {}
    })
    // The listing reads Git while both deletes run and replies after both ended.
    const pendingAtScan = snapshotPendingWorktreeRemovals()
    removed.resolve({})
    failed.resolve({})
    await _settlePendingWorktreeRemovalsForTests()
    const rows: { id: string; hostId?: undefined }[] = [
      { id: removal.worktreeId },
      { id: other.worktreeId }
    ]

    for (const clientReadsMarker of [true, false]) {
      expect(
        projectPendingWorktreeRemovals(rows, (row) => row.id, clientReadsMarker, pendingAtScan)
      ).toEqual([{ id: other.worktreeId }])
    }
    // A listing that began after the delete finished reads Git's current answer as-is.
    expect(
      projectPendingWorktreeRemovals(rows, (row) => row.id, true, snapshotPendingWorktreeRemovals())
    ).toBe(rows)
  })

  it('keeps WSL checkouts on the inline delete', () => {
    expect(removesInBackground('/work/feature', {})).toBe(true)
    expect(removesInBackground('/home/me/feature', { wslDistro: 'Ubuntu' })).toBe(false)
  })

  it('returns listings untouched when nothing is being removed', () => {
    const rows: { id: string; hostId?: undefined }[] = [{ id: removal.worktreeId }]
    expect(
      projectPendingWorktreeRemovals(
        rows,
        (row) => row.id,
        false,
        snapshotPendingWorktreeRemovals()
      )
    ).toBe(rows)
  })
})
