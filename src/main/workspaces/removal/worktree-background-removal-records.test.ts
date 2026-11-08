import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
  startBackgroundWorktreeRemoval,
  stopBackgroundWorktreeRemovals,
  waitForPendingWorktreeRemoval
} from './worktree-background-removal'
import {
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals
} from './worktree-removal-listing'
import type * as WorktreeRemovalRecords from './worktree-removal-records'
import { readWorktreeRemovalRecords } from './worktree-removal-records'

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
  directory = await mkdtemp(join(tmpdir(), 'orca-worktree-removal-records-'))
  await loadWorktreeRemovalRecords(directory)
})

afterEach(async () => {
  vi.useRealTimers()
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
    const job = interruptedJob()
    void startBackgroundWorktreeRemoval({ removal, ...job })
    await vi.waitFor(() => expect(job.started()).toBe(true))
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
    ).toEqual([{ id: removal.worktreeId, removing: true }, { id: 'repo-1::/work/other' }])
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
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
