import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, lstatMock, readFileMock, rmMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  lstatMock: vi.fn(),
  readFileMock: vi.fn(),
  rmMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readFile: readFileMock,
  rm: rmMock
}))

import { getLocalWorktreePathAccess, removeLocalWorktreePath } from './local-worktree-filesystem'

function completeExecFile(stdout = ''): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(null, stdout, '')
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
    execFileMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
    completeExecFile()
  })

  afterEach(() => {
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
    expect(rmMock).toHaveBeenCalledWith('C:\\repo\\feature', { recursive: true, force: true })
    expect(execFileMock).not.toHaveBeenCalled()
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

      expect(execFileMock).toHaveBeenCalledTimes(3)
      expect(execFileMock).toHaveBeenNthCalledWith(
        1,
        'wsl.exe',
        expect.arrayContaining(['-d', 'Ubuntu']),
        expect.objectContaining({ encoding: 'utf8' }),
        expect.any(Function)
      )
      const removeArgs = execFileMock.mock.calls[2]?.[1] as string[]
      expect(removeArgs.at(-1)).toContain('rm -rf --')
      expect(removeArgs.at(-1)).toContain(
        String.raw`rm -rf -- '\''/mnt/c/Users/me/repo feature'\''`
      )
      expect(rmMock).not.toHaveBeenCalled()
    })
  })
})
