import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import path from 'node:path'
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

import {
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  discardChanges,
  isWithinWorktree
} from './status'

describe('discardChanges', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    lstatMock.mockReset()
    realpathMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
    lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    realpathMock.mockImplementation(async (targetPath: string) => path.resolve(targetPath))
  })

  it('restores tracked files from HEAD', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'src/file.ts\n' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await discardChanges('/repo', 'src/file.ts')

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['ls-files', '--error-unmatch', '--', ':(literal)src/file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['restore', '--worktree', '--source=HEAD', '--', ':(literal)src/file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('removes untracked files from disk', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not tracked'))

    await discardChanges('/repo', 'src/new-file.ts')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['clean', '-ffdx', '--', ':(literal)src/new-file.ts'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('rejects paths that traverse outside the worktree', async () => {
    await expect(discardChanges('/repo', '../../etc/passwd')).rejects.toThrow(
      'resolves outside the worktree'
    )

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('accepts in-tree Windows paths when resolving containment', async () => {
    expect(isWithinWorktree(path.win32, 'C:\\repo', 'C:\\repo\\src\\file.ts')).toBe(true)
  })
})

describe('bulk git helpers', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    lstatMock.mockReset()
    realpathMock.mockReset()
    rmMock.mockReset()
    lstatMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    realpathMock.mockImplementation(async (targetPath: string) => path.resolve(targetPath))
  })

  it('chunks bulk stage requests to avoid oversized argv payloads', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    const filePaths = Array.from({ length: 201 }, (_, i) => `src/file-${i}.ts`)
    await bulkStageFiles('/repo', filePaths)

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['add', '--', ...filePaths.slice(0, 100).map((filePath) => `:(literal)${filePath}`)],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['add', '--', ...filePaths.slice(200).map((filePath) => `:(literal)${filePath}`)],
      {
        cwd: '/repo'
      }
    )
  })

  it('chunks bulk unstage requests to avoid oversized argv payloads', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    const filePaths = Array.from({ length: 101 }, (_, i) => `src/file-${i}.ts`)
    await bulkUnstageFiles('/repo', filePaths)

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'restore',
        '--staged',
        '--',
        ...filePaths.slice(100).map((filePath) => `:(literal)${filePath}`)
      ],
      {
        cwd: '/repo'
      }
    )
  })

  it('discards tracked and untracked paths in bulk', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'src/file.ts\0docs/readme.md\0' })
      .mockResolvedValueOnce({ stdout: '' })

    await bulkDiscardChanges('/repo', ['src/file.ts', 'src/new-file.ts', 'docs', 'scratch'])

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'ls-files',
        '-z',
        '--',
        ':(literal)src/file.ts',
        ':(literal)src/new-file.ts',
        ':(literal)docs',
        ':(literal)scratch'
      ],
      {
        cwd: '/repo'
      }
    )
    // Why: a pathspec is tracked if git reports either the exact path or a
    // tracked descendant, which keeps directory pathspecs on the restore path.
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['restore', '--worktree', '--source=HEAD', '--', ':(literal)src/file.ts', ':(literal)docs'],
      {
        cwd: '/repo'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['clean', '-ffdx', '--', ':(literal)src/new-file.ts', ':(literal)scratch'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('handles large tracked path lists during bulk discard classification', async () => {
    const trackedStdout = Array.from({ length: 150_000 }, (_, index) => `docs/file-${index}.ts`)
      .join('\0')
      .concat('\0')
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: trackedStdout }).mockResolvedValueOnce({
      stdout: ''
    })

    await bulkDiscardChanges('/repo', ['docs'])

    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['restore', '--worktree', '--source=HEAD', '--', ':(literal)docs'],
      {
        cwd: '/repo'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('rejects bulk discard paths that traverse outside the worktree', async () => {
    await expect(bulkDiscardChanges('/repo', ['src/file.ts', '../outside.txt'])).rejects.toThrow(
      'resolves outside the worktree'
    )

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })
})
