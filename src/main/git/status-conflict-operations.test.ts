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
  existsSyncMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

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
    existsSyncMock.mockReset()
  })

  it('ignores a stale REBASE_HEAD when no rebase directory exists', async () => {
    readFileMock.mockResolvedValue('gitdir: /repo/.git/worktrees/feature\n')
    existsSyncMock.mockImplementation((target: string) => {
      if (target.endsWith('MERGE_HEAD')) {
        return false
      }
      if (target.endsWith('CHERRY_PICK_HEAD')) {
        return false
      }
      if (target.endsWith('rebase-merge')) {
        return false
      }
      if (target.endsWith('rebase-apply')) {
        return false
      }
      if (target.endsWith('REBASE_HEAD')) {
        return true
      }
      return false
    })

    const result = await detectConflictOperation('/repo')

    expect(result).toBe('unknown')
  })
})
