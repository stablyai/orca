import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  loadWorktreeRemovalRecords,
  projectPendingWorktreeRemovals,
  resumeInterruptedWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  startBackgroundWorktreeRemoval,
  stopBackgroundWorktreeRemovals,
  waitForPendingWorktreeRemoval
} from './worktree-background-removal'
import type * as WorktreeRemovalRecords from './worktree-removal-records'
import {
  readWorktreeRemovalRecords,
  worktreeRemovalRecordsFile,
  writeWorktreeRemovalRecords
} from './worktree-removal-records'

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

/** A delete Git never finishes on its own, like one a quit or crash cuts short. */
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

  it('clears the record when the delete fails so the row returns live and retryable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const publish = vi.fn()
    const result = startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        throw new Error('Permission denied')
      },
      publish
    })
    await expect(result).rejects.toThrow('Permission denied')
    await _settlePendingWorktreeRemovalsForTests()

    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
    expect(isPending()).toBe(false)
    // Once on acceptance, once after the row left the table.
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('starts Git after a bounded wait when the record write stalls', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.mocked(writeWorktreeRemovalRecords).mockReturnValueOnce(new Promise(() => {}))
    const run = vi.fn(async () => ({}))
    void startBackgroundWorktreeRemoval({
      removal,
      run,
      publish: () => {}
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
    await _settlePendingWorktreeRemovalsForTests()
  })

  it('replies without waiting for the record to be cleared on disk', async () => {
    let finishClear = (): void => {}
    const publish = vi.fn()
    const result = startBackgroundWorktreeRemoval({
      removal,
      run: async () => {
        vi.mocked(writeWorktreeRemovalRecords).mockReturnValueOnce(
          new Promise<void>((resolve) => {
            finishClear = resolve
          })
        )
        return {}
      },
      publish
    })

    await expect(result).resolves.toEqual({})
    expect(publish).toHaveBeenCalledTimes(2)
    finishClear()
    await _settlePendingWorktreeRemovalsForTests()
  })

  it('stops Git on quit without waiting and keeps the record for the next start', async () => {
    const job = interruptedJob()
    void startBackgroundWorktreeRemoval({ removal, ...job })
    await vi.waitFor(() => expect(job.started()).toBe(true))

    expect(stopBackgroundWorktreeRemovals()).toBeUndefined()
    expect(job.stopped()).toBe(true)
    await _settlePendingWorktreeRemovalsForTests()

    expect(await readWorktreeRemovalRecords(directory)).toHaveLength(1)
    // Only the start was published: a stopped delete is neither removed nor failed.
    expect(job.publish).toHaveBeenCalledTimes(1)
  })

  it('marks the row as removing after a restart and finishes it with the same job', async () => {
    const job = interruptedJob()
    void startBackgroundWorktreeRemoval({ removal, ...job })
    await vi.waitFor(() => expect(job.started()).toBe(true))
    stopBackgroundWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()

    // Restart: nothing in memory, only the file.
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
    // A request that joined after the restart gets the resumed delete's result.
    await expect(joined).resolves.toEqual({})
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('does not start a second job for a removal that is still running', async () => {
    void startBackgroundWorktreeRemoval({ removal, ...interruptedJob() })
    const jobFor = vi.fn()
    resumeInterruptedWorktreeRemovals(jobFor)
    expect(jobFor).not.toHaveBeenCalled()
    stopBackgroundWorktreeRemovals()
    await _settlePendingWorktreeRemovalsForTests()
  })

  it('reads back only well-formed records from the file', async () => {
    const valid = {
      worktreeId: 'repo-1::/work/a',
      repoId: 'repo-1',
      repoPath: '/work/repo',
      worktreePath: '/work/a',
      branch: '',
      head: '',
      deleteBranch: false,
      force: true,
      requestedAt: 5
    }
    await writeFile(
      worktreeRemovalRecordsFile(directory),
      JSON.stringify({ version: 1, removals: [valid, { worktreeId: 'x' }, null] })
    )
    expect(await readWorktreeRemovalRecords(directory)).toEqual([valid])

    await writeFile(worktreeRemovalRecordsFile(directory), '{not json')
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  })
})
