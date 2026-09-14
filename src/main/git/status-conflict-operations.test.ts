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

  // Both cases below assert the probed prefix rather than the joined string so they exercise
  // Win32 pointer resolution on every host, where `path.join` still uses the host separator.
  it('probes the drive spelling of a drvfs gitdir pointer on Windows', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    readFileMock.mockResolvedValue('gitdir: /mnt/c/Users/me/repo/.git/worktrees/feature\n')
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    try {
      await expect(detectConflictOperation(String.raw`C:\Users\me\repo\feature`)).resolves.toBe(
        'unknown'
      )
      for (const [target] of accessMock.mock.calls) {
        expect(target).toContain(String.raw`C:\Users\me\repo\.git\worktrees\feature`)
      }
      expect(accessMock).toHaveBeenCalledTimes(4)
    } finally {
      platformSpy.mockRestore()
    }
  })

  // The worktree path itself can be guest-spelled (git in the distro reports it that way), so the
  // gitfile read has to be translated too or it ENOENTs before any pointer resolution happens.
  it('reads the gitfile at the host spelling of a guest-spelled worktree', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    readFileMock.mockResolvedValue('gitdir: /mnt/c/Users/me/repo/.git/worktrees/feature\n')
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    try {
      await expect(detectConflictOperation('/mnt/c/Users/me/repo/feature')).resolves.toBe('unknown')
      expect(readFileMock).toHaveBeenCalledTimes(1)
      expect(readFileMock.mock.calls[0][0]).toContain(String.raw`C:\Users\me\repo\feature`)
    } finally {
      platformSpy.mockRestore()
    }
  })

  // A plain clone inside the distro has a `.git` directory, so the gitfile read fails and the
  // markers are probed under the worktree itself — that fallback needs the host spelling too.
  it('probes a directory .git under the distro share when the caller names one', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    readFileMock.mockRejectedValue(Object.assign(new Error('EISDIR'), { code: 'EISDIR' }))
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    try {
      await expect(
        detectConflictOperation('/home/me/repo/feature', { wslDistro: 'Ubuntu' })
      ).resolves.toBe('unknown')
      expect(readFileMock.mock.calls[0][0]).toContain(
        String.raw`\\wsl.localhost\Ubuntu\home\me\repo\feature`
      )
      for (const [target] of accessMock.mock.calls) {
        expect(target).toContain(String.raw`\\wsl.localhost\Ubuntu\home\me\repo\feature`)
      }
      expect(accessMock).toHaveBeenCalledTimes(4)
    } finally {
      platformSpy.mockRestore()
    }
  })

  // `git worktree repair --relative-paths` (2.48+) writes `gitdir: ../../..`, which the guest
  // spelling of the worktree would resolve drive-relative on Win32.
  it('resolves a relative gitdir pointer against the host spelling of the worktree', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    readFileMock.mockResolvedValue('gitdir: ../.git/worktrees/feature\n')
    accessMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

    try {
      await expect(detectConflictOperation('/mnt/c/Users/me/repo/feature')).resolves.toBe('unknown')
      for (const [target] of accessMock.mock.calls) {
        expect(target).toContain(String.raw`C:\Users\me\repo\.git\worktrees\feature`)
      }
      expect(accessMock).toHaveBeenCalledTimes(4)
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('probes the distro UNC share when the caller names one', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    readFileMock.mockResolvedValue('gitdir: /home/me/repo/.git/worktrees/feature\n')
    accessMock.mockImplementation(async (target: string) =>
      target.includes(String.raw`\\wsl.localhost\Ubuntu\home\me\repo\.git\worktrees\feature`) &&
      target.endsWith('MERGE_HEAD')
        ? undefined
        : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    )

    try {
      await expect(
        detectConflictOperation(String.raw`C:\Users\me\repo\feature`, { wslDistro: 'Ubuntu' })
      ).resolves.toBe('merge')
    } finally {
      platformSpy.mockRestore()
    }
  })
})
