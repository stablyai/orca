import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  execFileSync: vi.fn(),
  spawn: spawnMock
}))

import {
  awaitWindowsHostGitEnvironmentReady,
  configureWindowsHostGitEnvironmentReadiness,
  gitExecFileAsync,
  gitExecFileAsyncBuffer,
  gitSpawnAfterWindowsEnvironmentReady,
  gitStreamStdout
} from './runner'

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
}

function createMockChildProcess(pid: number): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = pid
  child.kill = vi.fn()
  return child
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
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

describe('Windows host Git environment readiness', () => {
  const originalPath = process.env.Path

  beforeEach(() => {
    execFileMock.mockReset()
    spawnMock.mockReset()
  })

  afterEach(() => {
    configureWindowsHostGitEnvironmentReadiness(null)
    if (originalPath === undefined) {
      delete process.env.Path
    } else {
      process.env.Path = originalPath
    }
  })

  it('waits for each native operation and refreshes a snapshotted PATH', async () => {
    await withPlatform('win32', async () => {
      const ready = deferred()
      const waitUntilReady = vi.fn(() => ready.promise)
      const child = createMockChildProcess(1234)
      execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
        callback(null, 'ok', '')
        return child
      })
      configureWindowsHostGitEnvironmentReadiness(waitUntilReady)
      process.env.Path = 'hydrating-path'

      const firstExec = gitExecFileAsync(['status'], {
        cwd: String.raw`C:\repo`,
        env: { Path: 'stale-path' }
      })

      expect(waitUntilReady).toHaveBeenCalledOnce()
      expect(execFileMock).not.toHaveBeenCalled()
      process.env.Path = 'hydrated-path'
      ready.resolve()
      await expect(firstExec).resolves.toEqual({ stdout: 'ok', stderr: '' })
      expect(execFileMock.mock.calls[0]?.[2]?.env?.Path).toBe('hydrated-path')

      await expect(gitExecFileAsync(['status'], { cwd: String.raw`C:\repo` })).resolves.toEqual({
        stdout: 'ok',
        stderr: ''
      })
      expect(waitUntilReady).toHaveBeenCalledTimes(2)
    })
  })

  it('waits before native spawned Git and refreshes a snapshotted PATH', async () => {
    await withPlatform('win32', async () => {
      const ready = deferred()
      const waitUntilReady = vi.fn(() => ready.promise)
      const child = createMockChildProcess(1234)
      spawnMock.mockReturnValue(child)
      configureWindowsHostGitEnvironmentReadiness(waitUntilReady)
      process.env.Path = 'hydrating-path'

      const spawned = gitSpawnAfterWindowsEnvironmentReady(['clone', 'url', 'repo'], {
        cwd: String.raw`C:\repo`,
        env: { Path: 'stale-path' },
        stdio: ['ignore', 'ignore', 'pipe']
      })

      expect(waitUntilReady).toHaveBeenCalledOnce()
      expect(spawnMock).not.toHaveBeenCalled()
      process.env.Path = 'hydrated-path'
      ready.resolve()

      await expect(spawned).resolves.toBe(child)
      expect(spawnMock.mock.calls[0]?.[2]?.env?.Path).toBe('hydrated-path')
    })
  })

  it('does not gate spawned Git routed through WSL on the Windows host profile', async () => {
    await withPlatform('win32', async () => {
      const waitUntilReady = vi.fn(() => new Promise<void>(() => {}))
      const child = createMockChildProcess(1234)
      spawnMock.mockReturnValue(child)
      configureWindowsHostGitEnvironmentReadiness(waitUntilReady)

      await expect(
        gitSpawnAfterWindowsEnvironmentReady(['clone', 'url', 'repo'], {
          cwd: String.raw`C:\repo`,
          wslDistro: 'Ubuntu',
          stdio: ['ignore', 'ignore', 'pipe']
        })
      ).resolves.toBe(child)

      expect(waitUntilReady).not.toHaveBeenCalled()
      expect(spawnMock).toHaveBeenCalled()
    })
  })

  it('does not spawn Git when canceled during Windows environment readiness', async () => {
    await withPlatform('win32', async () => {
      const ready = deferred()
      const controller = new AbortController()
      configureWindowsHostGitEnvironmentReadiness(() => ready.promise)

      const spawned = gitSpawnAfterWindowsEnvironmentReady(['status'], {
        cwd: String.raw`C:\repo`,
        signal: controller.signal,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      controller.abort()

      await expect(spawned).rejects.toMatchObject({ name: 'AbortError' })
      expect(spawnMock).not.toHaveBeenCalled()
      ready.resolve()
    })
  })

  it('cancels async Git immediately while Windows environment readiness is pending', async () => {
    await withPlatform('win32', async () => {
      const ready = deferred()
      const controller = new AbortController()
      configureWindowsHostGitEnvironmentReadiness(() => ready.promise)

      const operation = gitExecFileAsync(['status'], {
        cwd: String.raw`C:\repo`,
        signal: controller.signal
      })
      controller.abort()

      await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
      expect(execFileMock).not.toHaveBeenCalled()
      ready.resolve()
    })
  })

  it('does not gate WSL paths at a synchronous Git consumer boundary', async () => {
    await withPlatform('win32', async () => {
      const waitUntilReady = vi.fn(() => new Promise<void>(() => {}))
      configureWindowsHostGitEnvironmentReadiness(waitUntilReady)

      await expect(
        awaitWindowsHostGitEnvironmentReady({
          cwd: String.raw`\\wsl.localhost\Ubuntu\home\me\repo`
        })
      ).resolves.toBeUndefined()

      expect(waitUntilReady).not.toHaveBeenCalled()
    })
  })

  it('does not gate Git routed through WSL on the Windows host profile', async () => {
    await withPlatform('win32', async () => {
      const waitUntilReady = vi.fn(() => new Promise<void>(() => {}))
      const child = createMockChildProcess(1234)
      execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
        callback(null, 'ok', '')
        return child
      })
      configureWindowsHostGitEnvironmentReadiness(waitUntilReady)

      await expect(
        gitExecFileAsync(['status'], {
          cwd: String.raw`C:\repo`,
          wslDistro: 'Ubuntu'
        })
      ).resolves.toEqual({ stdout: 'ok', stderr: '' })

      expect(waitUntilReady).not.toHaveBeenCalled()
      expect(execFileMock).toHaveBeenCalled()
    })
  })

  it('gates buffered native Git reads on the current generation', async () => {
    await withPlatform('win32', async () => {
      const ready = deferred()
      const child = createMockChildProcess(1234)
      execFileMock.mockImplementation((_cmd, _args, _options, callback) => {
        callback(null, Buffer.from('blob'), Buffer.alloc(0))
        return child
      })
      configureWindowsHostGitEnvironmentReadiness(() => ready.promise)

      const read = gitExecFileAsyncBuffer(['show', 'HEAD:file'], { cwd: String.raw`C:\repo` })
      expect(execFileMock).not.toHaveBeenCalled()
      ready.resolve()

      await expect(read).resolves.toEqual({ stdout: Buffer.from('blob') })
    })
  })

  it('gates native Git streams and refreshes their snapshotted PATH', async () => {
    await withPlatform('win32', async () => {
      const ready = deferred()
      const child = createMockChildProcess(1234)
      spawnMock.mockReturnValue(child)
      configureWindowsHostGitEnvironmentReadiness(() => ready.promise)
      process.env.Path = 'hydrated-stream-path'

      const stream = gitStreamStdout(['status'], {
        cwd: String.raw`C:\repo`,
        env: { Path: 'stale-stream-path' },
        onStdout: () => {}
      })
      expect(spawnMock).not.toHaveBeenCalled()
      ready.resolve()
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
      expect(spawnMock.mock.calls[0]?.[2]?.env?.Path).toBe('hydrated-stream-path')
      child.emit('close', 0)

      await expect(stream).resolves.toEqual({ stoppedEarly: false })
    })
  })
})
