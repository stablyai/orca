import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type * as ChildProcessModule from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process')
  return { ...actual, execFile: execFileMock, spawn: spawnMock }
})

import { gitExecFileAsync, gitExecFileAsyncBuffer, gitSpawn, gitStreamStdout } from './runner'
import { _resetOwnerRepoCache, getOwnerRepoForRemote } from '../github/github-repository-identity'

type FakeChild = ChildProcess & { stdin: { end: ReturnType<typeof vi.fn> } }

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() }) as FakeChild['stdin']
  child.stdout = new EventEmitter() as ChildProcess['stdout']
  child.stderr = new EventEmitter() as ChildProcess['stderr']
  child.kill = vi.fn() as ChildProcess['kill']
  return child
}

async function withWindows<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('WSL Git login-shell stdio isolation', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetOwnerRepoCache()
  })

  it('resolves GitHub identity when the login shell prints the public issue banner', async () => {
    await withWindows(async () => {
      const child = fakeChild()
      execFileMock.mockImplementation((_binary, args, _options, callback) => {
        const output =
          args[4] === '-c'
            ? 'https://github.com/stablyai/orca.git\n'
            : 'hello\nhttps://github.com/stablyai/orca.git\n'
        queueMicrotask(() => callback(null, output, ''))
        return child
      })

      await expect(
        getOwnerRepoForRemote(String.raw`C:\orca-10917-repro`, 'origin', null, {
          wslDistro: 'Ubuntu'
        })
      ).resolves.toEqual({ owner: 'stablyai', repo: 'orca' })
    })
  })

  it('uses the exact wsl.exe argv and preserves production stdin', async () => {
    await withWindows(async () => {
      const child = fakeChild()
      execFileMock.mockImplementation((binary, args, options, callback) => {
        expect(binary).toBe('wsl.exe')
        expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'sh', '-c'])
        expect(args).toHaveLength(6)
        expect(args[5]).toContain('exec 3<&0')
        expect(args[5]).toContain('exec 0<&3')
        expect(args[5]).toContain('exec "\\$_orca_wsl_shell" -ilc')
        expect(args[5]).toContain('/mnt/c/repo')
        expect(options.cwd).toBeUndefined()
        queueMicrotask(() => callback(null, 'https://github.com/stablyai/orca.git\n', ''))
        return child
      })

      await expect(
        gitExecFileAsync(['remote', 'get-url', 'origin'], {
          cwd: String.raw`C:\repo`,
          wslDistro: 'Ubuntu',
          stdin: 'caller input'
        })
      ).resolves.toEqual({ stdout: 'https://github.com/stablyai/orca.git\n', stderr: '' })
      expect(child.stdin.end).toHaveBeenCalledWith('caller input')
    })
  })

  it('keeps binary output opaque and preserves the Git payload ordering', async () => {
    await withWindows(async () => {
      const child = fakeChild()
      execFileMock.mockImplementation((_binary, args, _options, callback) => {
        expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'sh', '-c'])
        expect(args[5]).toContain("'git'")
        expect(args[5]).toContain('show')
        expect(args[5]).toContain('binary')
        callback(null, Buffer.from([0, 255, 0]), Buffer.alloc(0))
        return child
      })

      await expect(
        gitExecFileAsyncBuffer(['show', 'binary'], {
          cwd: String.raw`C:\repo`,
          wslDistro: 'Ubuntu'
        })
      ).resolves.toEqual({ stdout: Buffer.from([0, 255, 0]) })
    })
  })

  it('preserves spawned channels, status, and launch errors', async () => {
    await withWindows(async () => {
      const child = fakeChild()
      spawnMock.mockImplementation((binary, args) => {
        expect(binary).toBe('wsl.exe')
        expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'sh', '-c'])
        queueMicrotask(() => {
          child.stdout?.emit('data', Buffer.from('stdout\0'))
          child.stderr?.emit('data', Buffer.from('stderr\n'))
          child.emit('close', 7)
        })
        return child
      })

      const result = await new Promise<{ stdout: Buffer; stderr: Buffer; status: number }>(
        (resolve, reject) => {
          const spawned = gitSpawn(['status'], {
            cwd: String.raw`C:\repo`,
            wslDistro: 'Ubuntu',
            stdio: ['pipe', 'pipe', 'pipe']
          })
          const stdout: Buffer[] = []
          const stderr: Buffer[] = []
          spawned.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
          spawned.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
          spawned.once('error', reject)
          spawned.once('close', (status) =>
            resolve({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              status: status ?? -1
            })
          )
        }
      )
      expect(result).toEqual({
        stdout: Buffer.from('stdout\0'),
        stderr: Buffer.from('stderr\n'),
        status: 7
      })

      const launchError = new Error('wsl unavailable')
      spawnMock.mockImplementation(() => {
        throw launchError
      })
      expect(() => gitSpawn(['status'], { cwd: String.raw`C:\repo`, wslDistro: 'Ubuntu' })).toThrow(
        launchError
      )
    })
  })

  it('streams exact stdout and rejects nonzero Git with stderr', async () => {
    await withWindows(async () => {
      const child = fakeChild()
      spawnMock.mockImplementation(() => {
        queueMicrotask(() => {
          child.stdout?.emit('data', Buffer.from('porcelain\0'))
          child.stderr?.emit('data', Buffer.from('fatal\n'))
          child.emit('close', 7)
        })
        return child
      })

      const chunks: string[] = []
      await expect(
        gitStreamStdout(['status'], {
          cwd: String.raw`C:\repo`,
          wslDistro: 'Ubuntu',
          onStdout: (chunk) => {
            chunks.push(chunk)
          }
        })
      ).rejects.toMatchObject({ message: 'git exited with 7: fatal\n', stderr: 'fatal\n' })
      expect(chunks).toEqual(['porcelain\0'])
    })
  })

  it('leaves native, generic WSL, and non-Git login-shell routing unchanged', async () => {
    await withWindows(async () => {
      const child = fakeChild()
      spawnMock.mockReturnValue(child)
      gitSpawn(['status'], { cwd: String.raw`C:\repo`, stdio: 'ignore' })
      expect(spawnMock).toHaveBeenLastCalledWith(
        'git',
        ['status'],
        expect.objectContaining({ cwd: String.raw`C:\repo` })
      )

      execFileMock.mockImplementation((_binary, args, _options, callback) => {
        expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'bash', '-c'])
        callback(null, '', '')
        return child
      })
      const { commandExecFileAsync } = await import('./runner')
      await commandExecFileAsync('ssh', ['-G', 'github-work'], {
        cwd: String.raw`C:\repo`,
        wslDistro: 'Ubuntu'
      })
    })
  })
})
