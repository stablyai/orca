import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import {
  createBoundedFileReaderModuleMock,
  createFsPromisesModuleMock,
  createGitRunnerModuleMock
} from './status-test-harness'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  gitStreamOptionsMock,
  lstatMock,
  realpathMock,
  readFileMock,
  statMock,
  rmMock,
  accessMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn(),
  accessMock: vi.fn()
}))

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({
    lstatMock,
    realpathMock,
    readFileMock,
    statMock,
    rmMock,
    accessMock
  })
)

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { abortMerge, abortRebase, detectConflictOperation } from './status'

describe('abortMerge', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('runs git merge --abort in the worktree', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await abortMerge('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['merge', '--abort'], { cwd: '/repo' })
  })
})

describe('abortRebase', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('runs git rebase --abort in the worktree', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await abortRebase('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rebase', '--abort'], { cwd: '/repo' })
  })
})
describe('detectConflictOperation', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    accessMock.mockReset()
  })

  it('ignores a stale REBASE_HEAD when no rebase directory exists', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    accessMock.mockImplementation(async (target: string) => {
      // Only REBASE_HEAD is present: the marker git leaves behind after a rebase finishes.
      if (target.endsWith('REBASE_HEAD')) {
        return undefined
      }
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
    })

    const result = await detectConflictOperation('/repo')

    expect(result).toBe('unknown')
  })

  it.each([
    ['MERGE_HEAD', 'merge'],
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase'],
    ['CHERRY_PICK_HEAD', 'cherry-pick']
  ])('reports %s as %s', async (marker, expected) => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    accessMock.mockImplementation(async (target: string) => {
      if (target.endsWith(marker)) {
        return undefined
      }
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' })
    })

    await expect(detectConflictOperation('/repo')).resolves.toBe(expected)
  })

  // The four markers are independent, so serializing them costs four round trips
  // on a UNC git dir for something one wave answers.
  it('probes every marker concurrently', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    let concurrent = 0
    let peakConcurrent = 0
    accessMock.mockImplementation(async () => {
      concurrent += 1
      peakConcurrent = Math.max(peakConcurrent, concurrent)
      await Promise.resolve()
      concurrent -= 1
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await detectConflictOperation('/repo')

    expect(accessMock).toHaveBeenCalledTimes(4)
    expect(peakConcurrent).toBe(4)
  })

  it('reads as unknown when the git dir cannot be reached at all', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }))
    accessMock.mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }))

    await expect(detectConflictOperation('/repo')).resolves.toBe('unknown')
  })
})
