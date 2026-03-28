import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

const { execFileAsyncMock, readFileMock, rmMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  readFileMock: vi.fn(),
  rmMock: vi.fn()
}))

vi.mock('util', async () => {
  const actual = await vi.importActual('util')
  return {
    ...actual,
    promisify: vi.fn(() => execFileAsyncMock)
  }
})

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  rm: rmMock
}))

import { discardChanges, isWithinWorktree } from './status'

describe('discardChanges', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
  })

  it('restores tracked files from HEAD', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: 'src/file.ts\n' })
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await discardChanges('/repo', 'src/file.ts')

    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['ls-files', '--error-unmatch', '--', 'src/file.ts'],
      {
        cwd: '/repo',
        encoding: 'utf-8'
      }
    )
    expect(execFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      'git',
      ['restore', '--worktree', '--source=HEAD', '--', 'src/file.ts'],
      {
        cwd: '/repo',
        encoding: 'utf-8'
      }
    )
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('removes untracked files from disk', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error('not tracked'))

    await discardChanges('/repo', 'src/new-file.ts')

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(rmMock).toHaveBeenCalledWith('/repo/src/new-file.ts', {
      force: true,
      recursive: true
    })
  })

  it('rejects paths that traverse outside the worktree', async () => {
    await expect(discardChanges('/repo', '../../etc/passwd')).rejects.toThrow(
      'resolves outside the worktree'
    )

    expect(execFileAsyncMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()
  })

  it('accepts in-tree Windows paths when resolving containment', async () => {
    expect(isWithinWorktree(path.win32, 'C:\\repo', 'C:\\repo\\src\\file.ts')).toBe(true)
  })
})
