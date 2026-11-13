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

import { prepareLocalWorktreeFilesystem } from './local-worktree-filesystem'
import '../../filesystem/host-tree-removal'
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

  // Captured verbatim from live hosts: GNU coreutils 9.4 (Ubuntu 24.04) and BusyBox v1.36.1.
  it.each([
    ['GNU', "stat: cannot statx '/mnt/c/repo/missing/.git': No such file or directory\n"],
    ['GNU', "stat: cannot statx '/mnt/c/repo/missing/.git': Not a directory\n"],
    ['BusyBox', "stat: can't stat '/mnt/c/repo/missing/.git': No such file or directory\n"],
    ['BusyBox', "stat: can't stat '/mnt/c/repo/missing/.git': Not a directory\n"]
  ])('reports a missing WSL stat target as ENOENT on %s userland', async (_userland, stderr) => {
    await withPlatform('win32', async () => {
      failExecFile(1, stderr)
      const { access } = await prepareLocalWorktreeFilesystem(['/mnt/c/repo'], {
        wslDistro: 'Ubuntu'
      })

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
        const { access } = await prepareLocalWorktreeFilesystem(['/mnt/c/repo'], {
          wslDistro: 'Ubuntu'
        })

        for (const inspect of [access.statPath, access.layoutStatPath, access.realPath]) {
          await expect(inspect('/mnt/c/repo/locked')).rejects.toThrow('Permission denied')
        }
        await expect(isWorktreePathMissing('/mnt/c/repo/locked', access.statPath)).resolves.toBe(
          false
        )
      })
    }
  )
})
