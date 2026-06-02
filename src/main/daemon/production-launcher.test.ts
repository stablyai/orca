import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { createProductionLauncher } from './production-launcher'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { DaemonClient } from './client'
import type { SubprocessHandle } from './session'

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

    const socketPath = join(dir, 'test.sock')
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

    const launch = launcher(socketPathFor(dir), tokenPathFor(dir))
    handlers.message[0]?.({ type: 'ready' })
    const handle = await launch

    expect(handle.shutdown).toEqual(expect.any(Function))
    expect(handlers.message).toHaveLength(0)
    expect(handlers.error).toHaveLength(0)
    expect(handlers.exit).toHaveLength(0)
    expect(child.disconnect).toHaveBeenCalled()
    expect(child.unref).toHaveBeenCalled()
  })

  it('removes shutdown exit listener when force-kill timeout settles first', async () => {
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
        kill: vi.fn(),
        disconnect: vi.fn(),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)

      const launcher = createProductionLauncher({
        getDaemonEntryPath: () => join(dir, 'daemon-entry.js')
      })

      const launch = launcher(socketPathFor(dir), tokenPathFor(dir))
      handlers.message[0]?.({ type: 'ready' })
      const handle = await launch

      const shutdown = handle.shutdown()
      expect(handlers.exit).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(5000)
      await shutdown

      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
      expect(handlers.exit).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

function socketPathFor(dir: string): string {
  return join(dir, 'test.sock')
}

function tokenPathFor(dir: string): string {
  return join(dir, 'test.token')
}
