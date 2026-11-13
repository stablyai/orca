import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  runProcessMock,
  lstatMock,
  statMock,
  realpathMock,
  readFileMock,
  rmMock,
  groupSignal,
  groupForce
} = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  lstatMock: vi.fn(),
  statMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  rmMock: vi.fn(),
  groupSignal: vi.fn(),
  groupForce: vi.fn()
}))

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

vi.mock('../../git/command-runner/process-capture/wsl-process-group-termination', () => ({
  createWslProcessGroupTermination: () => ({
    signal: groupSignal,
    force: groupForce,
    wrapGuestArgs: (args: string[]) => args,
    stripControlOutput: (text: string) => text
  })
}))

import type { ProcessSpec, ProcessResult } from '@orca/process-host/process-spec'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { removeLocalWorktreePath, getLocalWorktreePathAccess } from './local-worktree-filesystem'
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
    groupSignal.mockReset()
    groupForce.mockReset()
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
})

it('does not start a WSL recursive delete when already cancelled', async () => {
  await withPlatform('win32', async () => {
    runProcessMock.mockClear()
    const controller = new AbortController()
    controller.abort()
    await expect(
      removeLocalWorktreePath('C:/repo/wt', { wslDistro: 'Ubuntu' }, controller.signal)
    ).rejects.toBe(controller.signal.reason)
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})

it.each(['normal', 'no-spawn', 'cancel', 'unverified-timeout'] as const)(
  'joins WSL recursive delete outcome with qualified proof: %s',
  async (mode) => {
    await withPlatform('win32', async () => {
      let release!: (proof: boolean) => void
      const groupEnded = new Promise<boolean>((resolve) => {
        release = resolve
      })
      groupSignal.mockReturnValue(groupEnded)
      groupForce.mockResolvedValue(false)
      let complete!: (result: ProcessResult) => void
      const childOutcome = new Promise<ProcessResult>((resolve) => {
        complete = resolve
      })
      let spec!: ProcessSpec
      runProcessMock.mockImplementation((input: ProcessSpec) => {
        spec = input
        if (mode === 'no-spawn') {
          input.onChildTerminated?.()
          return Promise.reject(new Error('wsl.exe missing'))
        }
        return childOutcome
      })
      const controller = new AbortController()
      let settled = false
      const pending = removeLocalWorktreePath(
        'C:/repo/wt',
        { wslDistro: 'Ubuntu' },
        controller.signal
      )
      const outcome = pending.then(
        () => {
          settled = true
          return undefined
        },
        (error: unknown) => {
          settled = true
          return error
        }
      )
      if (mode === 'no-spawn') {
        expect(await outcome).toMatchObject({ message: 'wsl.exe missing' })
        return
      }
      const result = {
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: mode === 'unverified-timeout'
      }
      if (mode === 'normal') {
        spec.onChildTerminated?.()
        complete(result)
        controller.abort()
        expect(await outcome).toBeUndefined()
        return
      }
      if (mode === 'cancel') {
        controller.abort()
      }
      if (typeof spec.terminationBarrier !== 'object') {
        throw new Error('guest barrier missing')
      }
      const stopping = spec.terminationBarrier.signal(createFakeSpawnedChild(1234))
      spec.onChildTerminated?.()
      complete(result)
      await Promise.resolve()
      await Promise.resolve()
      expect(settled).toBe(false)
      release(mode === 'cancel')
      await stopping
      if (mode === 'cancel') {
        expect(await outcome).toBe(controller.signal.reason)
      } else {
        await Promise.resolve()
        expect(settled).toBe(false)
      }
    })
  }
)
