import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, lstatMock, statMock, realpathMock, readFileMock, rmMock } = vi.hoisted(
  () => ({
    runProcessMock: vi.fn(),
    lstatMock: vi.fn(),
    statMock: vi.fn(),
    realpathMock: vi.fn(),
    readFileMock: vi.fn(),
    rmMock: vi.fn()
  })
)

// Process-host tests own encoding, timeouts, and console hiding; assert guest commands here.
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  stat: statMock,
  realpath: realpathMock,
  readFile: readFileMock,
  rm: rmMock
}))

import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toHostFilesystemPath,
  toHostRemovalPath
} from './local-worktree-filesystem'
import { isWorktreePathMissing } from './worktree-removal-safety'

function completeExecFile(stdout = ''): void {
  runProcessMock.mockResolvedValue({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
}

function failExecFile(exitCode: number, stderr = 'missing'): void {
  runProcessMock.mockResolvedValue({
    code: exitCode,
    signal: null,
    stdout: '',
    stderr,
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
    statMock.mockReset()
    realpathMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
    completeExecFile()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses host filesystem operations when no WSL distro is selected', async () => {
    lstatMock.mockResolvedValue({ type: 'symlink' })
    statMock.mockResolvedValue({ type: 'directory' })
    realpathMock.mockResolvedValue('C:\\metadata')
    readFileMock.mockResolvedValue('gitdir: ../.git/worktrees/feature')

    const access = getLocalWorktreePathAccess()
    await expect(access.statPath('C:\\repo\\.git')).resolves.toEqual({ type: 'symlink' })
    await expect(access.layoutStatPath('C:\\repo\\.git')).resolves.toEqual({ type: 'directory' })
    await expect(access.realPath('C:\\repo\\.git')).resolves.toBe('C:\\metadata')
    await access.readPath('C:\\repo\\.git')
    await removeLocalWorktreePath('C:\\repo\\feature')

    expect(lstatMock).toHaveBeenCalledWith('C:\\repo\\.git')
    expect(statMock).toHaveBeenCalledWith('C:\\repo\\.git')
    expect(realpathMock).toHaveBeenCalledWith('C:\\repo\\.git')
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
      expect(rmMock).toHaveBeenCalledWith(`\\\\?\\${longPath}`, { recursive: true, force: true })
    })
  })

  it('uses the same Win32 namespace for host directory creation on Windows', async () => {
    await withPlatform('win32', async () => {
      const longPath = `C:\\repo\\${'nested\\'.repeat(40)}feature`

      expect(toHostFilesystemPath(longPath)).toBe(`\\\\?\\${longPath}`)
    })
  })

  it('leaves POSIX WSL paths unchanged on a Windows host', async () => {
    await withPlatform('win32', async () => {
      expect(toHostFilesystemPath('/home/me/worktrees')).toBe('/home/me/worktrees')
    })
  })

  it('leaves WSL UNC paths unchanged on a Windows host', async () => {
    await withPlatform('win32', async () => {
      const wslPath = String.raw`\\wsl.localhost\Ubuntu\home\me\worktrees`
      expect(toHostFilesystemPath(wslPath)).toBe(wslPath)
    })
  })

  it('retries a transient Windows lock as a whole pass, never per entry', async () => {
    vi.useFakeTimers()
    await withPlatform('win32', async () => {
      const error = Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' })
      rmMock.mockRejectedValueOnce(error).mockResolvedValueOnce(undefined)

      const removal = removeLocalWorktreePath('C:\\repo\\feature')
      await vi.advanceTimersByTimeAsync(250)

      await expect(removal).resolves.toBeUndefined()
      // Async rm's maxRetries multiplies per directory level when a file stays open.
      expect(rmMock.mock.calls).toEqual([
        [toHostRemovalPath('C:\\repo\\feature'), { recursive: true, force: true }],
        [toHostRemovalPath('C:\\repo\\feature'), { recursive: true, force: true }]
      ])
    })
  })

  it('names the file another program holds open once the retries run out', async () => {
    vi.useFakeTimers()
    await withPlatform('win32', async () => {
      const held = toHostRemovalPath('C:\\repo\\feature\\profile\\lockfile')
      rmMock.mockRejectedValue(
        Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${held}'`), {
          code: 'EBUSY',
          path: held
        })
      )

      const removal = removeLocalWorktreePath('C:\\repo\\feature').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(3_750)

      expect(await removal).toMatchObject({
        code: 'EBUSY',
        message:
          'C:\\repo\\feature\\profile\\lockfile is open in another program. Close that program and delete again.'
      })
      expect(rmMock).toHaveBeenCalledTimes(5)
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
      completeExecFile('symbolic link')
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })
      await expect(access.statPath('/home/me/repo/.git')).resolves.toEqual({ type: 'symlink' })
      completeExecFile('directory')
      await expect(access.layoutStatPath('/home/me/repo/.git')).resolves.toEqual({
        type: 'directory'
      })
      expect(runProcessMock.mock.calls.slice(0, 2).map(([request]) => request.args.at(-1))).toEqual(
        [
          "LC_ALL=C stat -c %F -- '/home/me/repo/.git'",
          "LC_ALL=C stat -L -c %F -- '/home/me/repo/.git'"
        ]
      )

      completeExecFile('/home/me/metadata with spaces \n')
      await expect(access.realPath('/home/me/repo/.git')).resolves.toBe(
        '/home/me/metadata with spaces '
      )
      expect(runProcessMock.mock.calls[2]?.[0].args.at(-1)).toBe(
        "LC_ALL=C realpath -e -- '/home/me/repo/.git'"
      )
      completeExecFile('  gitdir: /home/me/repo with spaces/.git/worktrees/feature \n')
      await expect(access.readPath("/home/me/repo's file")).resolves.toBe(
        '  gitdir: /home/me/repo with spaces/.git/worktrees/feature \n'
      )
      expect(runProcessMock.mock.calls[3]?.[0]).toMatchObject({
        program: 'wsl.exe',
        args: ['-d', 'Ubuntu', '--exec', 'sh', '-c', "LC_ALL=C cat -- '/home/me/repo'\\''s file'"],
        timeoutMs: 30_000
      })

      completeExecFile()
      await removeLocalWorktreePath('C:\\Users\\me\\repo feature', { wslDistro: 'Ubuntu' })

      expect(runProcessMock).toHaveBeenCalledTimes(5)
      expect(runProcessMock).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          program: 'wsl.exe',
          args: expect.arrayContaining(['-d', 'Ubuntu']),
          // The inherited cwd may be the worktree being removed (#16463).
          cwd: expect.any(String)
        })
      )
      const removeArgs: unknown = runProcessMock.mock.calls[4]?.[0].args
      if (!Array.isArray(removeArgs) || !removeArgs.every((arg) => typeof arg === 'string')) {
        throw new Error('Expected WSL removal command arguments')
      }
      expect(removeArgs.at(-1)).toBe(String.raw`rm -rf -- '/mnt/c/Users/me/repo feature'`)
      expect(rmMock).not.toHaveBeenCalled()
    })
  })

  it('never starts a login or interactive shell for filesystem reads', async () => {
    await withPlatform('win32', async () => {
      completeExecFile('file')
      await getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' }).statPath('/home/me/repo/.git')

      // Avoid login-shell banners instead of filtering potentially valid file content.
      const args = runProcessMock.mock.calls[0]?.[0].args as string[]
      expect(args).toContain('-c')
      expect(args).not.toContain('-lc')
      expect(args).not.toContain('-ilc')
      expect(args.at(-1)).not.toContain('getent passwd')
      await expect(
        getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' }).layoutStatPath('/home/me/repo/.git')
      ).resolves.toEqual({ type: 'other' })
      await expect(
        getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' }).realPath('/home/me/repo/.git')
      ).rejects.toThrow('Invalid WSL canonical path')
    })
  })

  // Captured verbatim from live hosts: GNU coreutils 9.4 (Ubuntu 24.04) and BusyBox v1.36.1.
  it.each([
    ['GNU', "stat: cannot statx '/mnt/c/repo/missing/.git': No such file or directory\n"],
    ['GNU', "stat: cannot statx '/mnt/c/repo/missing/.git': Not a directory\n"],
    ['BusyBox', "stat: can't stat '/mnt/c/repo/missing/.git': No such file or directory\n"],
    ['BusyBox', "stat: can't stat '/mnt/c/repo/missing/.git': Not a directory\n"]
  ])('reports a missing WSL stat target as ENOENT on %s userland', async (_userland, stderr) => {
    await withPlatform('win32', async () => {
      failExecFile(1, stderr)
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })

      for (const inspect of [access.statPath, access.layoutStatPath, access.realPath]) {
        await expect(inspect('/mnt/c/repo/missing/.git')).rejects.toMatchObject({ code: 'ENOENT' })
      }
      await expect(isWorktreePathMissing('/mnt/c/repo/missing', access.statPath)).resolves.toBe(
        true
      )
    })
  })

  it.each([
    ['GNU', "stat: cannot statx '/mnt/c/repo/locked': Permission denied\n"],
    ['BusyBox', "stat: can't stat '/mnt/c/repo/locked': Permission denied\n"]
  ])(
    'does not treat an unreadable WSL stat target as missing on %s userland',
    async (_userland, stderr) => {
      await withPlatform('win32', async () => {
        failExecFile(1, stderr)
        const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })

        for (const inspect of [access.statPath, access.layoutStatPath, access.realPath]) {
          await expect(inspect('/mnt/c/repo/locked')).rejects.toThrow('Permission denied')
        }
        await expect(isWorktreePathMissing('/mnt/c/repo/locked', access.statPath)).resolves.toBe(
          false
        )
      })
    }
  )

  it('normalizes only definitive cat absence, preserving path-bearing read failures', async () => {
    await withPlatform('win32', async () => {
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })
      const path = '/mnt/c/ENOENT/repo/.git/commondir'
      // Synthetic cat-shaped diagnostics exercise the same transport as the recorded stat errors.
      for (const reason of ['No such file or directory', 'Not a directory']) {
        failExecFile(1, `cat: ${path}: ${reason}\n`)
        await expect(access.readPath(path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
      failExecFile(1, `cat: ${path}: Permission denied\n`)
      await expect(access.readPath(path)).rejects.not.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('pins the stat probe to the C locale so its error text stays English', async () => {
    await withPlatform('win32', async () => {
      completeExecFile('directory')
      await getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' }).statPath('/mnt/c/repo/feature')

      const args = runProcessMock.mock.calls[0]?.[0].args as string[]
      expect(args.at(-1)).toContain('LC_ALL=C stat -c %F --')
    })
  })

  it('reports a translated stat failure as a failure rather than as absence', async () => {
    await withPlatform('win32', async () => {
      // Synthetic localization verifies that unknown errors cannot prove absence if LC_ALL=C regresses.
      failExecFile(1, "stat: <translated verb> '/mnt/c/repo/missing': <translated errno>\n")
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })

      for (const inspect of [
        access.statPath,
        access.layoutStatPath,
        access.realPath,
        access.readPath
      ]) {
        await expect(inspect('/mnt/c/repo/missing')).rejects.not.toMatchObject({ code: 'ENOENT' })
      }
      await expect(isWorktreePathMissing('/mnt/c/repo/missing', access.statPath)).resolves.toBe(
        false
      )
    })
  })
})
