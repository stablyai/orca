import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { workerState, appMock } = vi.hoisted(() => ({
  workerState: {
    calls: [] as unknown[][],
    instance: null as object | null,
    error: null as Error | null
  },
  appMock: {
    isPackaged: true,
    getAppPath: vi.fn(() => '/apps/orca/app.asar'),
    on: vi.fn()
  }
}))

vi.mock('node:worker_threads', () => ({
  Worker: class WorkerMock {
    constructor(...args: unknown[]) {
      workerState.calls.push(args)
      if (workerState.error) {
        throw workerState.error
      }
      return workerState.instance as WorkerMock
    }
  }
}))

vi.mock('electron', () => ({
  app: appMock
}))

import { installMainThreadHangWatchdog } from './main-thread-hang-watchdog'

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

function fakeWorker() {
  return {
    postMessage: vi.fn(),
    unref: vi.fn(),
    on: vi.fn(),
    once: vi.fn()
  }
}

describe('installMainThreadHangWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    workerState.calls = []
    workerState.instance = null
    workerState.error = null
    appMock.on.mockReset()
    appMock.isPackaged = true
    delete process.env.ORCA_HANG_WATCHDOG_FORCE
    delete process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS
    delete process.env.ORCA_HANG_WATCHDOG_CHECK_INTERVAL_MS
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.ORCA_HANG_WATCHDOG_FORCE
    delete process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS
    delete process.env.ORCA_HANG_WATCHDOG_CHECK_INTERVAL_MS
  })

  it('is a no-op off macOS', () => {
    expect(
      withPlatform('win32', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
    expect(
      withPlatform('linux', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
    expect(workerState.calls).toHaveLength(0)
  })

  it('is a no-op in unpackaged builds unless forced', () => {
    appMock.isPackaged = false
    expect(
      withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
    process.env.ORCA_HANG_WATCHDOG_FORCE = '1'
    const worker = fakeWorker()
    workerState.instance = worker
    expect(
      withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).not.toBeNull()
    delete process.env.ORCA_HANG_WATCHDOG_FORCE
  })

  it('starts a worker with pid, marker, and timing config', () => {
    const worker = fakeWorker()
    workerState.instance = worker
    const handle = withPlatform('darwin', () =>
      installMainThreadHangWatchdog({ userDataPath: '/ud' })
    )
    expect(handle).not.toBeNull()
    const [workerPath, rawOptions] = workerState.calls[0]
    const options = rawOptions as {
      name: string
      workerData: {
        parentPid: number
        markerPath: string
        timeoutMs: number
        checkIntervalMs: number
      }
    }
    expect(workerPath).toBe(
      join('/apps/orca/app.asar', 'out', 'main', 'main-thread-hang-watchdog-entry.js')
    )
    expect(options.name).toBe('orca-main-thread-hang-watchdog')
    expect(options.workerData).toMatchObject({
      parentPid: process.pid,
      markerPath: join('/ud', 'main-thread-hang.json'),
      timeoutMs: 45_000,
      checkIntervalMs: 5_000
    })
    expect(worker.unref).toHaveBeenCalled()
  })

  it('sends heartbeats on an interval and shutdown on stop', () => {
    const worker = fakeWorker()
    workerState.instance = worker
    const handle = withPlatform('darwin', () =>
      installMainThreadHangWatchdog({ userDataPath: '/ud' })
    )
    vi.advanceTimersByTime(6_000)
    const heartbeats = worker.postMessage.mock.calls.filter(([m]) => m.type === 'heartbeat')
    expect(heartbeats.length).toBe(3)

    handle?.stop()
    expect(worker.postMessage.mock.calls.some(([m]) => m.type === 'shutdown')).toBe(true)

    handle?.stop()
    const shutdowns = worker.postMessage.mock.calls.filter(([m]) => m.type === 'shutdown')
    expect(shutdowns.length).toBe(1)

    vi.advanceTimersByTime(10_000)
    const heartbeatsAfterStop = worker.postMessage.mock.calls.filter(
      ([m]) => m.type === 'heartbeat'
    )
    expect(heartbeatsAfterStop.length).toBe(3)
  })

  it('passes test timing overrides to the worker', () => {
    process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS = '900'
    process.env.ORCA_HANG_WATCHDOG_CHECK_INTERVAL_MS = '100'
    workerState.instance = fakeWorker()
    withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    const options = workerState.calls[0][1] as {
      workerData: { timeoutMs: number; checkIntervalMs: number }
    }
    expect(options.workerData).toMatchObject({ timeoutMs: 900, checkIntervalMs: 100 })
  })

  it('registers stop on will-quit', () => {
    workerState.instance = fakeWorker()
    withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    expect(appMock.on).toHaveBeenCalledWith('will-quit', expect.any(Function))
  })

  it('stops heartbeat work when the worker exits', () => {
    const worker = fakeWorker()
    workerState.instance = worker
    withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    const exitListener = worker.once.mock.calls.find(([event]) => event === 'exit')?.[1]
    expect(exitListener).toEqual(expect.any(Function))
    exitListener()
    vi.advanceTimersByTime(6_000)
    expect(worker.postMessage).not.toHaveBeenCalled()
  })

  it('returns null and stays inert when worker construction fails', () => {
    workerState.error = new Error('worker failure')
    expect(
      withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
  })
})
