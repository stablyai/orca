import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, lstatMock, readFileMock, rmMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  lstatMock: vi.fn(),
  readFileMock: vi.fn(),
  rmMock: vi.fn()
}))

// Why mock the chokepoint: encoding, timeout and the hidden console are its
// contract now, so this suite asserts what the distro is asked to run.
vi.mock('../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readFile: readFileMock,
  rm: rmMock
}))

import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toHostRemovalPath
} from './local-worktree-filesystem'

function completeExecFile(stdout = ''): void {
  runProcessMock.mockResolvedValue({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
}

function failExecFile(exitCode: number): void {
  runProcessMock.mockResolvedValue({
    code: exitCode,
    signal: null,
    stdout: '',
    stderr: 'missing',
    timedOut: false
  })
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('local worktree filesystem runtime access', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
    completeExecFile()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses host filesystem operations when no WSL distro is selected', async () => {
    lstatMock.mockResolvedValue({ type: 'file' })
    readFileMock.mockResolvedValue('gitdir: ../.git/worktrees/feature')

    const access = getLocalWorktreePathAccess()
    await access.statPath('C:\\repo\\.git')
    await access.readPath('C:\\repo\\.git')
    await removeLocalWorktreePath('C:\\repo\\feature')

    expect(lstatMock).toHaveBeenCalledWith('C:\\repo\\.git')
    expect(readFileMock).toHaveBeenCalledWith('C:\\repo\\.git', 'utf8')
    expect(rmMock).toHaveBeenCalledWith(
      toHostRemovalPath('C:\\repo\\feature'),
      expect.objectContaining({
        recursive: true,
        force: true
      })
    )
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('uses a Win32 long-path namespace for host removal on Windows', async () => {
    await withPlatform('win32', async () => {
      const longPath = `C:\\repo\\${'nested\\'.repeat(40)}feature`

      await removeLocalWorktreePath(longPath)

      expect(toHostRemovalPath(longPath)).toBe(`\\\\?\\${longPath}`)
      expect(rmMock).toHaveBeenCalledWith(
        `\\\\?\\${longPath}`,
        expect.objectContaining({
          recursive: true,
          force: true,
          maxRetries: expect.any(Number),
          retryDelay: expect.any(Number)
        })
      )
    })
  })

  it('retries transient host removal failures on Windows', async () => {
    vi.useFakeTimers()
    await withPlatform('win32', async () => {
      const error = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })
      rmMock.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined)

      const removal = removeLocalWorktreePath('C:\\repo\\feature')
      await vi.advanceTimersByTimeAsync(250)

      await expect(removal).resolves.toBeUndefined()
      expect(rmMock).toHaveBeenCalledTimes(2)
      expect(rmMock).toHaveBeenNthCalledWith(
        1,
        toHostRemovalPath('C:\\repo\\feature'),
        expect.objectContaining({
          recursive: true,
          force: true,
          maxRetries: expect.any(Number),
          retryDelay: expect.any(Number)
        })
      )
      expect(rmMock).toHaveBeenNthCalledWith(
        2,
        toHostRemovalPath('C:\\repo\\feature'),
        expect.objectContaining({
          recursive: true,
          force: true,
          maxRetries: expect.any(Number),
          retryDelay: expect.any(Number)
        })
      )
    })
  })

  it('does not retry host removal failures outside Windows', async () => {
    await withPlatform('linux', async () => {
      const error = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })
      rmMock.mockRejectedValue(error)

      await expect(removeLocalWorktreePath('/repo/feature')).rejects.toBe(error)
      expect(rmMock).toHaveBeenCalledTimes(1)
    })
  })

  it('uses the selected WSL distro for stat, read, and removal on Windows', async () => {
    await withPlatform('win32', async () => {
      completeExecFile('file')
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })
      await expect(access.statPath('/home/me/repo/.git')).resolves.toEqual({ type: 'file' })

      completeExecFile('gitdir: /home/me/repo/.git/worktrees/feature\n')
      await expect(access.readPath('/home/me/repo/.git')).resolves.toBe(
        'gitdir: /home/me/repo/.git/worktrees/feature\n'
      )

      completeExecFile()
      await removeLocalWorktreePath('C:\\Users\\me\\repo feature', { wslDistro: 'Ubuntu' })

      expect(runProcessMock).toHaveBeenCalledTimes(3)
      expect(runProcessMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          program: 'wsl.exe',
          args: expect.arrayContaining(['-d', 'Ubuntu'])
        })
      )
      const removeArgs = runProcessMock.mock.calls[2]?.[0].args as string[]
      expect(removeArgs.at(-1)).toContain('rm -rf --')
      expect(removeArgs.at(-1)).toContain(String.raw`rm -rf -- '/mnt/c/Users/me/repo feature'`)
      expect(rmMock).not.toHaveBeenCalled()
    })
  })

  it('never starts a login or interactive shell for filesystem reads', async () => {
    await withPlatform('win32', async () => {
      completeExecFile('file')
      await getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' }).statPath('/home/me/repo/.git')

      // Why: a login/interactive shell is what puts the distro's rc banner on the
      // stdout these callers parse. cat/stat/rm need nothing from the user's PATH,
      // so the shell mode is the fix rather than filtering what it prints.
      const args = runProcessMock.mock.calls[0]?.[0].args as string[]
      expect(args).toContain('-c')
      expect(args).not.toContain('-lc')
      expect(args).not.toContain('-ilc')
      expect(args.at(-1)).not.toContain('getent passwd')
    })
  })

  it('reports missing WSL stat targets with an ENOENT-shaped error', async () => {
    await withPlatform('win32', async () => {
      failExecFile(2)
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })

      await expect(access.statPath('/mnt/c/repo/missing/.git')).rejects.toMatchObject({
        code: 'ENOENT'
      })
    })
  })
})
