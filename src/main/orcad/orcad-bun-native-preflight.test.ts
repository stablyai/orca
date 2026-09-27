import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from '../ipc/parcel-watcher-process-subscription'
import { preflightOrcadBunNativeRuntime } from './orcad-bun-native-preflight'

const fixture = vi.hoisted(() => ({
  temp: vi.fn(),
  pty: vi.fn(),
  available: vi.fn(),
  startTime: vi.fn(),
  rows: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  dispose: vi.fn(),
  write: vi.fn(),
  remove: vi.fn()
}))
vi.mock('../daemon/pty-subprocess/spawn-preflight', () => ({ runPtySpawnHealthProbe: fixture.pty }))
vi.mock('../windows/windows-process-table', () => ({
  isWindowsProcessTableAvailable: fixture.available,
  isWindowsProcessStartTimeAvailable: fixture.startTime,
  readWindowsProcessIdentityTableFresh: fixture.rows
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
    await preflightOrcadBunNativeRuntime({ nativeFeatures: false })
    expect(fixture.pty).not.toHaveBeenCalled()
    expect(fixture.subscribe).not.toHaveBeenCalled()
  })

  it('still requires Windows ownership support on normal startup', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    fixture.startTime.mockReturnValue(false)
    await expect(preflightOrcadBunNativeRuntime({ nativeFeatures: false })).rejects.toThrow(
      'Windows process table'
    )
  })

  it('does not admit a failed PTY in explicit qualification', async () => {
    fixture.pty.mockRejectedValue(new Error('PTY spawn health check timed out'))
    await expect(preflightOrcadBunNativeRuntime()).rejects.toThrow(
      'PTY spawn health check timed out'
    )
  })

  it('awaits actual watcher delivery and unsubscribe before disposing temporary state', async () => {
    await preflightOrcadBunNativeRuntime()
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
    const readiness = preflightOrcadBunNativeRuntime()
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
    await expect(preflightOrcadBunNativeRuntime()).rejects.toThrow('native watcher failed')
    expect(fixture.unsubscribe).toHaveBeenCalledOnce()
    expect(fixture.dispose).toHaveBeenCalledOnce()
  })

  it('still disposes temporary state when unsubscribe fails', async () => {
    fixture.unsubscribe.mockRejectedValue(new Error('watcher did not exit'))
    await expect(preflightOrcadBunNativeRuntime()).rejects.toThrow('watcher did not exit')
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
      await expect(preflightOrcadBunNativeRuntime()).rejects.toThrow('Windows process table')
      expect(fixture.pty).not.toHaveBeenCalled()
      if (reason !== 'invalid-self-row') {
        expect(fixture.rows).not.toHaveBeenCalled()
      }
    }
  )

  it('reads a fresh self identity on Windows before qualifying the PTY', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await preflightOrcadBunNativeRuntime()
    expect(fixture.rows).toHaveBeenCalledOnce()
    expect(fixture.pty).toHaveBeenCalledOnce()
  })
})
