import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
  retryFailedWorktreeRemoval,
  startBackgroundWorktreeRemoval,
  stopBackgroundWorktreeRemovals,
  waitForPendingWorktreeRemoval,
  waitForWorktreeRemovalAcceptance
} from './worktree-background-removal'
import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  withUnregisteredRemovalCheckouts
} from './worktree-removal-listing'
import type * as WorktreeRemovalRecords from './worktree-removal-records'
import { readWorktreeRemovalRecords, writeWorktreeRemovalRecords } from './worktree-removal-records'
import {
  assertNoPendingWorktreeRemovalConflict,
  pendingWorktreeRemovals,
  persistWorktreeRemovalRecords
} from './worktree-removal-table'

vi.mock('./worktree-removal-records', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRemovalRecords>()
  return {
    ...actual,
    writeWorktreeRemovalRecords: vi.fn(actual.writeWorktreeRemovalRecords)
  }
})

const removal = {
  worktreeId: 'repo-1::/work/feature',
  repoId: 'repo-1',
  repoPath: '/work/repo',
  worktree: { path: '/work/feature', branch: 'refs/heads/feature', head: 'abc' },
  deleteBranch: true,
  force: false
}
const isPending = (): boolean => waitForPendingWorktreeRemoval(removal.worktreeId) !== undefined
let directory = ''

beforeEach(async () => {
  const actual = await vi.importActual<typeof WorktreeRemovalRecords>('./worktree-removal-records')
  vi.mocked(writeWorktreeRemovalRecords).mockImplementation(actual.writeWorktreeRemovalRecords)
  directory = await mkdtemp(join(tmpdir(), 'orca-worktree-removal-records-'))
  await loadWorktreeRemovalRecords(directory)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.mocked(writeWorktreeRemovalRecords).mockReset()
  _resetPendingWorktreeRemovalsForTests()
  await rm(directory, { recursive: true, force: true })
})

function interruptedJob(): {
  run: (stopSignal: AbortSignal) => Promise<never>
  publish: () => void
  started: () => boolean
  stopped: () => boolean
} {
  let started = false
  let stopped = false
  return {
    run: (stopSignal) =>
      new Promise((_resolve, reject) => {
        started = true
        stopSignal.addEventListener('abort', () => {
          stopped = true
          reject(new Error('The operation was aborted.'))
        })
      }),
    publish: vi.fn(),
    started: () => started,
    stopped: () => stopped
  }
}

describe('durable worktree removal records', () => {
  it('writes the record before Git starts and clears it once the delete succeeds', async () => {
    let recordedAtGitStart: unknown[] = []
    void startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        recordedAtGitStart = await readWorktreeRemovalRecords(directory)
        return {}
      },
      publish: () => {}
    })
    await _settlePendingWorktreeRemovalsForTests()

    expect(recordedAtGitStart).toEqual([
      {
        worktreeId: removal.worktreeId,
        repoId: 'repo-1',
        repoPath: '/work/repo',
        worktreePath: '/work/feature',
        branch: 'feature',
        head: 'abc',
        deleteBranch: true,
        force: false,
        requestedAt: expect.any(Number)
      }
    ])
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  })

  it('marks the row as removing after a restart and finishes it with the same job', async () => {
    const actual = await vi.importActual<typeof WorktreeRemovalRecords>(
      './worktree-removal-records'
    )
    let releaseWrite!: () => void
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    vi.mocked(writeWorktreeRemovalRecords).mockImplementationOnce(async (...args) => {
      await writing
      await actual.writeWorktreeRemovalRecords(...args)
    })
    const job = interruptedJob()
    void startBackgroundWorktreeRemoval({ removal, ...job })
    const initial: { id: string; hostId?: 'local' }[] = [{ id: removal.worktreeId }]
    expect(
      projectPendingWorktreeRemovals(
        initial,
        (row) => row.id,
        true,
        snapshotPendingWorktreeRemovals()
      )
    ).toEqual(initial)
    expect(
      projectPendingWorktreeRemovals(
        initial,
        (row) => row.id,
        false,
        snapshotPendingWorktreeRemovals()
      )
    ).toEqual(initial)
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { branch: 'feature' })
    ).toThrow('Cleanup is pending')
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    releaseWrite()
    await waitForWorktreeRemovalAcceptance(removal.worktreeId)
    stopBackgroundWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()

    _resetPendingWorktreeRemovalsForTests()
    expect(isPending()).toBe(false)
    await loadWorktreeRemovalRecords(directory)
    const joined = waitForPendingWorktreeRemoval(removal.worktreeId)
    const rows: { id: string; hostId?: undefined }[] = [
      { id: removal.worktreeId },
      { id: 'repo-1::/work/other' }
    ]
    expect(
      projectPendingWorktreeRemovals(rows, (row) => row.id, true, snapshotPendingWorktreeRemovals())
    ).toEqual([
      { id: removal.worktreeId, removing: true, removalRecorded: true },
      { id: 'repo-1::/work/other' }
    ])
    expect(
      projectPendingWorktreeRemovals(
        rows,
        (row) => row.id,
        false,
        snapshotPendingWorktreeRemovals()
      )
    ).toEqual([{ id: 'repo-1::/work/other' }])

    const publish = vi.fn()
    const resumed: string[] = []
    resumeInterruptedWorktreeRemovals((record) => ({
      run: async () => {
        resumed.push(`${record.worktreePath} ${record.branch} ${record.deleteBranch}`)
        return {}
      },
      publish
    }))
    await _settlePendingWorktreeRemovalsForTests()

    expect(resumed).toEqual(['/work/feature feature true'])
    expect(isPending()).toBe(false)
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    await expect(joined).resolves.toEqual({})
  })

  it('retains the prior failure while a retry is unadmitted and after its save is refused', async () => {
    const actual = await vi.importActual<typeof WorktreeRemovalRecords>(
      './worktree-removal-records'
    )
    const failed = {
      worktreeId: removal.worktreeId,
      repoId: removal.repoId,
      repoPath: removal.repoPath,
      worktreePath: directory,
      branch: 'feature',
      head: 'abc',
      deleteBranch: true,
      force: false,
      requestedAt: 1,
      failure: { message: 'Files are busy. Retry deletion.', failedAt: 2 }
    }
    await actual.writeWorktreeRemovalRecords(directory, () => [failed])
    _resetPendingWorktreeRemovalsForTests()
    await loadWorktreeRemovalRecords(directory)
    let refuseWrite!: (error: Error) => void
    const writing = new Promise<void>((_resolve, reject) => {
      refuseWrite = reject
    })
    vi.mocked(writeWorktreeRemovalRecords).mockImplementationOnce(() => writing)
    const run = vi.fn(async () => ({}))
    const retried = retryFailedWorktreeRemoval(
      removal.worktreeId,
      'local',
      () => ({
        run,
        publish: () => {}
      }),
      true
    )
    const refusal = expect(retried).rejects.toThrow('Could not start deletion')
    expect(
      projectPendingWorktreeRemovals<{ id: string; hostId?: 'local' }>(
        [{ id: removal.worktreeId }],
        (row) => row.id,
        true,
        snapshotPendingWorktreeRemovals()
      )
    ).toEqual([{ id: removal.worktreeId, removalError: failed.failure.message }])
    expect(await withUnregisteredRemovalCheckouts(removal.repoId, [])).toHaveLength(1)
    await persistWorktreeRemovalRecords()
    expect(await readWorktreeRemovalRecords(directory)).toEqual([failed])
    refuseWrite(new Error('Disk full'))
    await refusal
    await _settlePendingWorktreeRemovalsForTests()
    expect(run).not.toHaveBeenCalled()
    _resetPendingWorktreeRemovalsForTests()
    await loadWorktreeRemovalRecords(directory)
    expect(waitForPendingWorktreeRemoval(removal.worktreeId)).toBeUndefined()
    expect(() =>
      assertNoPendingWorktreeRemovalConflict('/work/repo', { branch: 'feature' })
    ).toThrow('Retry deleting it before reusing its path or branch')
    expect(await readWorktreeRemovalRecords(directory)).toEqual([failed])
  })

  it('never resumes a refused force deletion captured alongside another repo admission', async () => {
    const actual = await vi.importActual<typeof WorktreeRemovalRecords>(
      './worktree-removal-records'
    )
    let releaseWrite!: () => void
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let refuseSecond!: (error: Error) => void
    const secondWrite = new Promise<void>((_resolve, reject) => {
      refuseSecond = reject
    })
    let secondReservedAtSnapshot = false
    vi.mocked(writeWorktreeRemovalRecords)
      .mockImplementationOnce(async (directory, current, committed) => {
        await writing
        await actual.writeWorktreeRemovalRecords(
          directory,
          () => {
            secondReservedAtSnapshot = pendingWorktreeRemovals.has('repo-2::/other/force')
            return current()
          },
          committed
        )
      })
      .mockImplementationOnce(() => secondWrite)
      .mockRejectedValueOnce(new Error('No space for a cleanup rewrite'))
    void startBackgroundWorktreeRemoval({ removal, ...interruptedJob() })
    const refused = startBackgroundWorktreeRemoval({
      removal: {
        ...removal,
        worktreeId: 'repo-2::/other/force',
        repoId: 'repo-2',
        repoPath: '/other/repo',
        worktree: { path: '/other/force', branch: 'refs/heads/force', head: 'def' },
        force: true
      },
      run: async () => ({}),
      publish: () => {}
    })
    const refusal = expect(refused).rejects.toThrow('Could not start deletion')
    releaseWrite()
    await waitForWorktreeRemovalAcceptance(removal.worktreeId)
    expect(secondReservedAtSnapshot).toBe(true)
    expect(pendingWorktreeRemovals.has('repo-2::/other/force')).toBe(true)
    refuseSecond(new Error('No space for the second record'))
    await refusal
    await persistWorktreeRemovalRecords()
    stopBackgroundWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    await loadWorktreeRemovalRecords(directory)

    expect(
      (await readWorktreeRemovalRecords(directory)).map((record) => record.worktreeId)
    ).toEqual([removal.worktreeId])
    expect(waitForPendingWorktreeRemoval('repo-2::/other/force')).toBeUndefined()
    expect(waitForPendingWorktreeRemoval(removal.worktreeId)).toBeDefined()
  })
})
