import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { forkMock, appMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  appMock: {
    isPackaged: true,
    getAppPath: vi.fn(() => '/apps/orca/app.asar'),
    on: vi.fn()
  }
}))

vi.mock('node:child_process', () => ({
  fork: forkMock
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

function fakeChild() {
  return {
    connected: true,
    stderr: { on: vi.fn() },
    on: vi.fn(),
    send: vi.fn(),
    disconnect: vi.fn(),
    kill: vi.fn()
  }
}

describe('installMainThreadHangWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    forkMock.mockReset()
    appMock.on.mockReset()
    appMock.isPackaged = true
    delete process.env.ORCA_HANG_WATCHDOG_FORCE
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a no-op off macOS', () => {
    expect(
      withPlatform('win32', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
    expect(
      withPlatform('linux', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('is a no-op in unpackaged builds unless forced', () => {
    appMock.isPackaged = false
    expect(
      withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
    process.env.ORCA_HANG_WATCHDOG_FORCE = '1'
    const child = fakeChild()
    forkMock.mockReturnValue(child)
    expect(
      withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).not.toBeNull()
    delete process.env.ORCA_HANG_WATCHDOG_FORCE
  })

  it('forks the watchdog as plain Node with pid, bundle, and marker config', () => {
    const child = fakeChild()
    forkMock.mockReturnValue(child)
    const handle = withPlatform('darwin', () =>
      installMainThreadHangWatchdog({ userDataPath: '/ud' })
    )
    expect(handle).not.toBeNull()
    const [, , options] = forkMock.mock.calls[0]
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(options.env.ORCA_HANG_WATCHDOG_PARENT_PID).toBe(String(process.pid))
    expect(options.env.ORCA_HANG_WATCHDOG_MARKER_PATH).toContain('/ud')
  })

  it('sends heartbeats on an interval and shutdown+disconnect on stop', () => {
    const child = fakeChild()
    forkMock.mockReturnValue(child)
    const handle = withPlatform('darwin', () =>
      installMainThreadHangWatchdog({ userDataPath: '/ud' })
    )
    vi.advanceTimersByTime(6_000)
    const heartbeats = child.send.mock.calls.filter(([m]) => m.type === 'heartbeat')
    expect(heartbeats.length).toBe(3)

    handle?.stop()
    expect(child.send.mock.calls.some(([m]) => m.type === 'shutdown')).toBe(true)
    expect(child.disconnect).toHaveBeenCalled()

    // Why: quit fires will-quit twice; a second stop must not resend or throw.
    handle?.stop()
    const shutdowns = child.send.mock.calls.filter(([m]) => m.type === 'shutdown')
    expect(shutdowns.length).toBe(1)

    vi.advanceTimersByTime(10_000)
    const heartbeatsAfterStop = child.send.mock.calls.filter(([m]) => m.type === 'heartbeat')
    expect(heartbeatsAfterStop.length).toBe(3)
  })

  it('registers stop on will-quit', () => {
    const child = fakeChild()
    forkMock.mockReturnValue(child)
    withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    expect(appMock.on).toHaveBeenCalledWith('will-quit', expect.any(Function))
  })

  it('returns null and stays inert when the fork itself fails', () => {
    forkMock.mockImplementation(() => {
      throw new Error('spawn failure')
    })
    expect(
      withPlatform('darwin', () => installMainThreadHangWatchdog({ userDataPath: '/ud' }))
    ).toBeNull()
  })
})
