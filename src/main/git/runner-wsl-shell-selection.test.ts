import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

import { gitExecFileAsync, gitSpawn } from './runner'
import {
  resetWslLoginShellPathCacheForTests,
  seedWslLoginShellPathForTests
} from './wsl-login-shell-path'

const DISTRO = 'Ubuntu'
const LOGIN_PATH = '/home/u/.linuxbrew/bin:/usr/bin:/bin'

function createMockChildProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    pid: number
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 1234
  child.kill = vi.fn()
  return child
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

/** The shell argv wsl.exe was handed: ['-d', distro, '--', shell, flag, script]. */
function shellArgsOfCall(index: number): string[] {
  return execFileMock.mock.calls[index]?.[1] as string[]
}

function spawnArgsOfCall(index: number): string[] {
  return spawnMock.mock.calls[index]?.[1] as string[]
}

function succeedingExecFile(): void {
  execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
    cb?.(null, 'ok', '')
    return createMockChildProcess()
  })
}

describe('WSL git shell selection', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    spawnMock.mockReset()
    resetWslLoginShellPathCacheForTests()
  })

  afterEach(() => {
    resetWslLoginShellPathCacheForTests()
  })

  it('keeps the login shell until the PATH probe has landed', async () => {
    await withPlatform('win32', async () => {
      succeedingExecFile()

      await gitExecFileAsync(['status', '--short'], { cwd: String.raw`C:\repo`, wslDistro: DISTRO })

      expect(shellArgsOfCall(0).slice(3, 5)).toEqual(['sh', '-lc'])
    })
  })

  it('uses the fast non-login shell once the login PATH is known', async () => {
    await withPlatform('win32', async () => {
      succeedingExecFile()
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      await gitExecFileAsync(['status', '--short'], { cwd: String.raw`C:\repo`, wslDistro: DISTRO })

      expect(shellArgsOfCall(0).slice(3, 5)).toEqual(['bash', '-c'])
      const script = shellArgsOfCall(0)[5]
      expect(script).toContain('/mnt/c/repo')
      expect(script).toContain("'git'")
      expect(script).toContain('status')
    })
  })

  it('replays the login-shell PATH so profile-installed git still resolves', async () => {
    await withPlatform('win32', async () => {
      succeedingExecFile()
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      await gitExecFileAsync(['status', '--short'], { cwd: String.raw`C:\repo`, wslDistro: DISTRO })

      const script = shellArgsOfCall(0)[5]
      expect(script).toContain(`PATH='${LOGIN_PATH}'`)
      // The PATH assignment must precede the locale prefix and the binary.
      expect(script.indexOf('PATH=')).toBeLessThan(script.indexOf("'git'"))
    })
  })

  it('keeps the login shell for network commands even after the probe lands', async () => {
    await withPlatform('win32', async () => {
      succeedingExecFile()
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      for (const args of [['fetch', '--prune'], ['pull'], ['push', 'origin', 'HEAD']]) {
        execFileMock.mockClear()
        await gitExecFileAsync(args, { cwd: String.raw`C:\repo`, wslDistro: DISTRO })
        expect(shellArgsOfCall(0).slice(3, 5)).toEqual(['sh', '-lc'])
      }
    })
  })

  it('finds read subcommands past leading global options', async () => {
    await withPlatform('win32', async () => {
      succeedingExecFile()
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      await gitExecFileAsync(['-c', 'core.quotePath=false', 'status', '--short'], {
        cwd: String.raw`C:\repo`,
        wslDistro: DISTRO
      })

      expect(shellArgsOfCall(0).slice(3, 5)).toEqual(['bash', '-c'])
    })
  })

  it('keeps login policy for mutating and unclassified commands', async () => {
    await withPlatform('win32', async () => {
      succeedingExecFile()
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      for (const args of [
        ['commit', '-m', 'message'],
        ['config', '--local', 'user.name', 'Orca'],
        ['branch', '--show-current']
      ]) {
        execFileMock.mockClear()
        await gitExecFileAsync(args, { cwd: String.raw`C:\repo`, wslDistro: DISTRO })
        expect(shellArgsOfCall(0).slice(3, 5)).toEqual(['sh', '-lc'])
      }
    })
  })

  it('falls back to the login shell when the fast shell cannot find git', async () => {
    await withPlatform('win32', async () => {
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)
      execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb?.(
          Object.assign(new Error('exit 127'), { code: 127 }),
          '',
          'bash: git: command not found'
        )
        return createMockChildProcess()
      })
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb?.(null, 'ok', '')
        return createMockChildProcess()
      })

      const { stdout } = await gitExecFileAsync(['status', '--short'], {
        cwd: String.raw`C:\repo`,
        wslDistro: DISTRO
      })

      expect(stdout).toBe('ok')
      expect(shellArgsOfCall(0).slice(3, 5)).toEqual(['bash', '-c'])
      expect(shellArgsOfCall(1).slice(3, 5)).toEqual(['sh', '-lc'])
    })
  })

  it('does not retry a genuine git failure', async () => {
    await withPlatform('win32', async () => {
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
        cb?.(Object.assign(new Error('bad revision'), { code: 128 }), '', 'fatal: bad revision')
        return createMockChildProcess()
      })

      await expect(
        gitExecFileAsync(['status', '--short'], { cwd: String.raw`C:\repo`, wslDistro: DISTRO })
      ).rejects.toThrow('bad revision')
      expect(execFileMock).toHaveBeenCalledTimes(1)
    })
  })

  it('applies the same shell selection to the streamed status hot path', async () => {
    await withPlatform('win32', async () => {
      spawnMock.mockImplementation(() => createMockChildProcess())
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      gitSpawn(['status', '--porcelain=v2'], { cwd: String.raw`C:\repo`, wslDistro: DISTRO })

      expect(spawnArgsOfCall(0).slice(3, 5)).toEqual(['bash', '-c'])
    })
  })

  it('keeps the streamed clone path on the login shell', async () => {
    await withPlatform('win32', async () => {
      spawnMock.mockImplementation(() => createMockChildProcess())
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      gitSpawn(['clone', '--progress', '--', 'git@host:o/r.git', '/tmp/r'], {
        cwd: String.raw`C:\repo`,
        wslDistro: DISTRO
      })

      expect(spawnArgsOfCall(0).slice(3, 5)).toEqual(['sh', '-lc'])
    })
  })

  it('leaves non-Windows platforms untouched', async () => {
    await withPlatform('linux', async () => {
      succeedingExecFile()
      seedWslLoginShellPathForTests(DISTRO, LOGIN_PATH)

      await gitExecFileAsync(['status', '--short'], { cwd: '/repo', wslDistro: DISTRO })

      expect(execFileMock.mock.calls[0]?.[0]).toBe('git')
    })
  })
})
