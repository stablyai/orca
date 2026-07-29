import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createProductionLauncher } from './production-launcher'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { DaemonClient } from './client'
import type { SubprocessHandle } from './session'
import { getDaemonSocketPath } from './daemon-spawner'

const { forkMock } = vi.hoisted(() => ({
  forkMock: vi.fn()
}))

vi.mock('child_process', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('child_process')
  return { ...actual, fork: forkMock }
})

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'prod-launcher-test-'))
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 44444,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData(_cb: (data: string) => void) {},
    onExit(cb: (code: number) => void) {
      onExitCb = cb
    },
    dispose: vi.fn()
  }
}

describe('createProductionLauncher', () => {
  let dir: string
  let handles: DaemonHandle[]

  beforeEach(() => {
    dir = createTestDir()
    handles = []
  })

  afterEach(async () => {
    for (const h of handles) {
      await h.shutdown().catch(() => {})
    }
    forkMock.mockReset()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a launcher function', () => {
    const launcher = createProductionLauncher({
      getDaemonEntryPath: () => '/fake/path.js'
    })
    expect(typeof launcher).toBe('function')
  })

  it('rejects either ownership argument without its pair before forking', async () => {
    const launcher = createProductionLauncher({
      getDaemonEntryPath: () => '/fake/path.js'
    })

    await expect(
      launcher(socketPathFor(dir), tokenPathFor(dir), join(dir, 'daemon.pid'))
    ).rejects.toThrow('provided together')
    await expect(
      launcher(socketPathFor(dir), tokenPathFor(dir), undefined, 'launch-a')
    ).rejects.toThrow('provided together')
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('can be used with DaemonSpawner (in-process fallback)', async () => {
    // Use in-process launcher for testing (same as DaemonSpawner tests)
    const launcher = async (socketPath: string, tokenPath: string) => {
      const handle = await startDaemon({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      handles.push(handle)
      return { shutdown: () => handle.shutdown() }
    }

    const socketPath = getDaemonSocketPath(dir)
    const tokenPath = join(dir, 'test.token')
    const handle = await launcher(socketPath, tokenPath)

    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    expect(client.isConnected()).toBe(true)
    client.disconnect()

    await handle.shutdown()
    handles.pop()
  })

  it('removes startup child listeners after readiness', async () => {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const child = {
      pid: 12345,
      killed: false,
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event]?.push(cb)
        return child
      }),
      off: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
        return child
      }),
      kill: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    const launcher = createProductionLauncher({
      getDaemonEntryPath: () => join(dir, 'daemon-entry.js')
    })

    const pidPath = join(dir, 'daemon.pid')
    const launch = launcher(socketPathFor(dir), tokenPathFor(dir), pidPath, 'launch-a')
    handlers.message[0]?.({ type: 'ready', startedAtMs: 123_456 })
    const handle = await launch

    expect(handle.shutdown).toEqual(expect.any(Function))
    expect(handlers.message).toHaveLength(0)
    expect(handlers.error).toHaveLength(0)
    expect(handlers.exit).toHaveLength(0)
    expect(child.disconnect).toHaveBeenCalled()
    expect(child.unref).toHaveBeenCalled()
    expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toEqual({
      pid: 12345,
      startedAtMs: 123_456,
      entryPath: join(dir, 'daemon-entry.js'),
      launchNonce: 'launch-a'
    })
    expect(forkMock).toHaveBeenCalledWith(
      join(dir, 'daemon-entry.js'),
      expect.arrayContaining(['--pid-record', pidPath, '--launch-nonce', 'launch-a']),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    )
  })

  it('resolves shutdown only after observing child exit', async () => {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const child = {
      pid: 12345,
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      on: vi.fn((event: string, callback: (arg?: unknown) => void) => {
        handlers[event]?.push(callback)
        return child
      }),
      once: vi.fn((event: string, callback: (arg?: unknown) => void) => {
        handlers[event]?.push(callback)
        return child
      }),
      off: vi.fn((event: string, callback: (arg?: unknown) => void) => {
        handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
        return child
      }),
      kill: vi.fn((signal: NodeJS.Signals) => {
        if (signal === 'SIGTERM') {
          queueMicrotask(() => {
            child.exitCode = 0
            for (const callback of handlers.exit.slice()) {
              callback(0)
            }
          })
        }
        return true
      }),
      disconnect: vi.fn(() => {
        child.connected = false
      }),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)
    const launcher = createProductionLauncher({
      getDaemonEntryPath: () => join(dir, 'daemon-entry.js')
    })
    const launch = launcher(socketPathFor(dir), tokenPathFor(dir))
    handlers.message[0]?.({ type: 'ready', startedAtMs: 123_456 })
    const handle = await launch

    await expect(handle.shutdown()).resolves.toBeUndefined()

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.exitCode).toBe(0)
  })

  it('rejects shutdown and releases child handles when SIGKILL never produces exit', async () => {
    vi.useFakeTimers()
    try {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      const child = {
        pid: 12345,
        killed: false,
        connected: false,
        exitCode: null,
        signalCode: null,
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event]?.push(cb)
          return child
        }),
        once: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event]?.push(cb)
          return child
        }),
        off: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return child
        }),
        kill: vi.fn(() => true),
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)

      const launcher = createProductionLauncher({
        getDaemonEntryPath: () => join(dir, 'daemon-entry.js')
      })

      const launch = launcher(socketPathFor(dir), tokenPathFor(dir))
      handlers.message[0]?.({ type: 'ready', startedAtMs: 123_456 })
      const handle = await launch

      const shutdown = expect(handle.shutdown()).rejects.toThrow(
        'Daemon did not exit after SIGKILL'
      )
      expect(handlers.exit).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(6000)
      await shutdown

      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      expect(handlers.exit).toHaveLength(0)
      expect(child.unref).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves readiness and signaling failures while releasing startup IPC', async () => {
    vi.useFakeTimers()
    try {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      const signalError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
      const child = {
        pid: 12345,
        connected: true,
        exitCode: null,
        signalCode: null,
        on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event]?.push(cb)
          return child
        }),
        once: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event]?.push(cb)
          return child
        }),
        off: vi.fn((event: string, cb: (arg?: unknown) => void) => {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return child
        }),
        kill: vi.fn(() => {
          throw signalError
        }),
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)

      const launcher = createProductionLauncher({
        getDaemonEntryPath: () => join(dir, 'daemon-entry.js')
      })
      const launch = launcher(socketPathFor(dir), tokenPathFor(dir))
      handlers.message[0]?.({ type: 'ready' })

      const error = await launch.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({ message: 'Daemon readiness identity is incomplete' }),
        signalError
      ])
      expect(child.disconnect).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
      expect(handlers.message).toHaveLength(0)
      expect(handlers.error).toHaveLength(0)
      expect(handlers.exit).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves PID publication and cleanup failures', async () => {
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const signalError = Object.assign(new Error('signal blocked'), { code: 'EPERM' })
    const child = {
      pid: 12345,
      connected: true,
      exitCode: null,
      signalCode: null,
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event]?.push(cb)
        return child
      }),
      once: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event]?.push(cb)
        return child
      }),
      off: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
        return child
      }),
      kill: vi.fn(() => {
        throw signalError
      }),
      disconnect: vi.fn(() => {
        child.connected = false
      }),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)
    const pidPath = join(dir, 'occupied.pid')
    writeFileSync(pidPath, 'occupied')
    const launcher = createProductionLauncher({
      getDaemonEntryPath: () => join(dir, 'daemon-entry.js')
    })

    const launch = launcher(socketPathFor(dir), tokenPathFor(dir), pidPath, 'launch-b')
    handlers.message[0]?.({ type: 'ready', startedAtMs: 123_456 })

    const error = await launch.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ code: 'EEXIST' }),
      signalError
    ])
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
  })
})

function socketPathFor(dir: string): string {
  return join(dir, 'test.sock')
}

function tokenPathFor(dir: string): string {
  return join(dir, 'test.token')
}
