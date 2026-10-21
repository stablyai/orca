import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from '../ipc/parcel-watcher-process-subscription'
import { PtySpawnHealthTimeoutError } from '../daemon/pty-subprocess/spawn-preflight'
import { preflightOrcadNativeRuntime } from './orcad-runtime-native-preflight'
import { WindowsProcessTableTimeoutError } from '../windows/windows-process-table-timeout-error'

const fixture = vi.hoisted(() => ({
  temp: vi.fn(),
  pty: vi.fn(),
  available: vi.fn(),
  startTime: vi.fn(),
  rows: vi.fn(),
  creationTime: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  dispose: vi.fn(),
  write: vi.fn(),
  remove: vi.fn()
}))
vi.mock('../daemon/pty-subprocess/spawn-preflight', () => ({
  PTY_SPAWN_HEALTH_TIMEOUT_MS: 4_000,
  PtySpawnHealthTimeoutError: class extends Error {
    constructor(timeoutMs: number) {
      super(`PTY spawn health check timed out after ${timeoutMs}ms`)
    }
  },
  runPtySpawnHealthProbe: fixture.pty
}))
vi.mock('../windows/windows-process-table', () => ({
  isWindowsProcessTableAvailable: fixture.available,
  isWindowsProcessStartTimeAvailable: fixture.startTime,
  readWindowsProcessIdentityTableFresh: fixture.rows,
  readWindowsProcessCreationTime: fixture.creationTime
}))
vi.mock('node:fs/promises', () => ({
  mkdtemp: fixture.temp,
  writeFile: fixture.write,
  rm: fixture.remove
}))
vi.mock('../ipc/parcel-watcher-process-supervisor', () => ({
  WatcherProcessSupervisor: class {
    subscribe = fixture.subscribe
    dispose = fixture.dispose
  }
}))

beforeEach(() => {
  vi.useFakeTimers()
  fixture.temp.mockResolvedValue('/temp/probe')
  fixture.pty.mockResolvedValue(undefined)
  fixture.available.mockReturnValue(true)
  fixture.startTime.mockReturnValue(true)
  fixture.rows.mockResolvedValue([{ pid: process.pid, creationTimeMs: Date.now() - 1_000 }])
  fixture.unsubscribe.mockResolvedValue(undefined)
  fixture.remove.mockResolvedValue(undefined)
  fixture.subscribe.mockImplementation(
    async (directory: string, callback: WatcherProcessCallback) => {
      fixture.write.mockImplementation(async () =>
        callback(null, [{ path: join(directory, 'ready'), type: 'create' }])
      )
      return { unsubscribe: fixture.unsubscribe }
    }
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('bundled native readiness', () => {
  it('keeps runtime startup independent of PTY or watcher probe availability', async () => {
    fixture.pty.mockRejectedValue(new Error('PTY spawn health check timed out'))
    fixture.subscribe.mockRejectedValue(new Error('ENOSPC: watch limit reached'))
    await preflightOrcadNativeRuntime({ nativeFeatures: false })
    expect(fixture.pty).not.toHaveBeenCalled()
    expect(fixture.subscribe).not.toHaveBeenCalled()
  })

  it('still requires Windows ownership support on normal startup', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    fixture.startTime.mockReturnValue(false)
    await expect(preflightOrcadNativeRuntime({ nativeFeatures: false })).rejects.toThrow(
      'Windows process table'
    )
  })

  // A loaded Windows runner timed the whole-table snapshot out, and startup failed readiness.
  it('identifies itself by one PID when the process-table snapshot times out', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    fixture.rows.mockRejectedValue(
      new WindowsProcessTableTimeoutError('windows process table timed out')
    )
    fixture.creationTime.mockReturnValue(Date.now() - 1_000)
    await expect(preflightOrcadNativeRuntime({ nativeFeatures: false })).resolves.toBeUndefined()
    expect(fixture.creationTime).toHaveBeenCalledWith(process.pid)
  })

  it('still fails when neither the snapshot nor the one-PID query can identify it', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    fixture.rows.mockRejectedValue(
      new WindowsProcessTableTimeoutError('windows process table timed out')
    )
    fixture.creationTime.mockReturnValue(null)
    await expect(preflightOrcadNativeRuntime({ nativeFeatures: false })).rejects.toThrow(
      'windows process table timed out'
    )
  })

  it('never falls back for an unreadable table, only for a slow one', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    fixture.rows.mockRejectedValue(new Error('windows process table is unreadable'))
    fixture.creationTime.mockReturnValue(Date.now() - 1_000)
    await expect(preflightOrcadNativeRuntime({ nativeFeatures: false })).rejects.toThrow(
      'windows process table is unreadable'
    )
    expect(fixture.creationTime).not.toHaveBeenCalled()
  })

  it('does not admit a failed PTY in explicit qualification', async () => {
    fixture.pty.mockRejectedValue(new Error('PTY spawn health check timed out'))
    await expect(preflightOrcadNativeRuntime()).rejects.toThrow('PTY spawn health check timed out')
  })

  it('gives a cold first Windows PTY spawn a longer budget', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await preflightOrcadNativeRuntime()
    expect(fixture.pty).toHaveBeenCalledExactlyOnceWith(15_000)
  })

  it('retries a timed-out PTY probe once with the normal budget', async () => {
    fixture.pty.mockRejectedValueOnce(new PtySpawnHealthTimeoutError(15_000))
    await preflightOrcadNativeRuntime()
    expect(fixture.pty.mock.calls).toEqual([[4_000], [4_000]])
  })

  it('fails when the retry also times out', async () => {
    fixture.pty.mockRejectedValue(new PtySpawnHealthTimeoutError(4_000))
    await expect(preflightOrcadNativeRuntime()).rejects.toThrow('timed out after 4000ms')
    expect(fixture.pty).toHaveBeenCalledTimes(2)
  })

  it('does not retry a PTY that spawned and failed', async () => {
    fixture.pty.mockRejectedValue(new Error('PTY spawn health check exited with code 1'))
    await expect(preflightOrcadNativeRuntime()).rejects.toThrow('exited with code 1')
    expect(fixture.pty).toHaveBeenCalledOnce()
  })

  it('awaits actual watcher delivery and unsubscribe before disposing temporary state', async () => {
    await preflightOrcadNativeRuntime()
    expect(fixture.pty).toHaveBeenCalledOnce()
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.remove).toHaveBeenCalledWith('/temp/probe', { recursive: true, force: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a subscribe blocked on capacity by the same readiness deadline', async () => {
    fixture.subscribe.mockImplementation(
      (
        _directory: string,
        _callback: WatcherProcessCallback,
        _options: unknown,
        hooks: WatcherProcessHooks
      ) =>
        new Promise((_resolve, reject) => {
          hooks.signal?.addEventListener('abort', () => reject(hooks.signal?.reason), {
            once: true
          })
        })
    )
    const readiness = preflightOrcadNativeRuntime()
    const rejected = expect(readiness).rejects.toThrow('readiness timed out')
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.remove).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up when native delivery fails before subscribe resolves', async () => {
    fixture.subscribe.mockImplementation(
      async (_directory: string, callback: WatcherProcessCallback) => {
        callback(new Error('native watcher failed'), [])
        return { unsubscribe: fixture.unsubscribe }
      }
    )
    await expect(preflightOrcadNativeRuntime()).rejects.toThrow('native watcher failed')
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
    expect(fixture.dispose).toHaveBeenCalledOnce()
  })

  it('still disposes temporary state when unsubscribe fails', async () => {
    fixture.unsubscribe.mockRejectedValue(new Error('watcher did not exit'))
    await expect(preflightOrcadNativeRuntime()).rejects.toThrow('watcher did not exit')
    expect(fixture.dispose).toHaveBeenCalledOnce()
    expect(fixture.remove).toHaveBeenCalledOnce()
  })

  it.each(['missing-addon', 'missing-creation-time', 'invalid-self-row'])(
    'refuses %s on Windows before spawning a PTY or allowing CIM fallback',
    async (reason) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      if (reason === 'missing-addon') {
        fixture.available.mockReturnValue(false)
      }
      if (reason === 'missing-creation-time') {
        fixture.startTime.mockReturnValue(false)
      }
      if (reason === 'invalid-self-row') {
        fixture.rows.mockResolvedValue([{ pid: process.pid }])
      }
      await expect(preflightOrcadNativeRuntime()).rejects.toThrow('Windows process table')
      expect(fixture.pty).not.toHaveBeenCalled()
      if (reason !== 'invalid-self-row') {
        expect(fixture.rows).not.toHaveBeenCalled()
      }
    }
  )

  it('reads a fresh self identity on Windows before qualifying the PTY', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await preflightOrcadNativeRuntime()
    expect(fixture.rows).toHaveBeenCalledOnce()
    expect(fixture.pty).toHaveBeenCalledOnce()
  })
})
