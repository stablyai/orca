import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appRelaunchMock,
  recordDurableCrashBreadcrumbMock,
  appOnceMock,
  appRemoveListenerMock,
  isMacUpdateInstallInFlightMock
} = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  recordDurableCrashBreadcrumbMock: vi.fn(),
  appOnceMock: vi.fn(),
  appRemoveListenerMock: vi.fn(),
  isMacUpdateInstallInFlightMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { relaunch: appRelaunchMock, once: appOnceMock, removeListener: appRemoveListenerMock }
}))
vi.mock('./mac-update-install-marker', () => ({
  isMacUpdateInstallInFlight: isMacUpdateInstallInFlightMock
}))
vi.mock('./crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import {
  _resetAppRelaunchStateForTests,
  cancelScheduledRelaunch,
  relaunchApp,
  scheduleRelaunchOnQuit
} from './app-relaunch'
import { _resetHydrateShellPathCache, _setLaunchPathForTests } from './startup/hydrate-shell-path'

const fireQuit = (): void => {
  const removed = appRemoveListenerMock.mock.calls.map(([, listener]) => listener)
  for (const [event, listener] of appOnceMock.mock.calls) {
    if (event === 'quit' && !removed.includes(listener)) {
      ;(listener as () => void)()
    }
  }
}

beforeEach(() => {
  appRelaunchMock.mockReset()
  recordDurableCrashBreadcrumbMock.mockReset()
  appOnceMock.mockReset()
  appRemoveListenerMock.mockReset()
  isMacUpdateInstallInFlightMock.mockReset()
  isMacUpdateInstallInFlightMock.mockReturnValue(false)
  _resetAppRelaunchStateForTests()
})

const originalPath = process.env.PATH

afterEach(() => {
  _resetHydrateShellPathCache()
  if (originalPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = originalPath
  }
})

describe('relaunchApp', () => {
  it('durably records the reason before scheduling the replacement process', () => {
    relaunchApp('gpu-fallback', { processReason: 'crashed', exitCode: 5 })

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('app_relaunch_requested', {
      processReason: 'crashed',
      exitCode: 5,
      reason: 'gpu-fallback'
    })
    expect(appRelaunchMock).toHaveBeenCalledOnce()
    expect(recordDurableCrashBreadcrumbMock.mock.invocationCallOrder[0]).toBeLessThan(
      appRelaunchMock.mock.invocationCallOrder[0]
    )
  })

  it('does not carry Orca PATH seeds into the replacement process', () => {
    process.env.PATH = '/seeded/newest-nvm/bin:/usr/bin'
    _setLaunchPathForTests('/usr/bin')
    let inheritedPath: string | undefined
    appRelaunchMock.mockImplementation(() => {
      inheritedPath = process.env.PATH
    })

    relaunchApp('renderer-request')

    expect(inheritedPath).toBe('/usr/bin')
    expect(process.env.PATH).toBe('/seeded/newest-nvm/bin:/usr/bin')
  })
})

describe('scheduleRelaunchOnQuit', () => {
  it('queues nothing when the quit is abandoned', () => {
    scheduleRelaunchOnQuit('admin-restart')

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledOnce()
    // The quit never fires; Electron must not be left holding a replacement process.
    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('queues exactly one replacement process no matter how many restarts were abandoned', () => {
    scheduleRelaunchOnQuit('admin-restart')
    scheduleRelaunchOnQuit('admin-restart')
    scheduleRelaunchOnQuit('profile-switch')

    expect(appOnceMock.mock.calls.filter(([event]) => event === 'quit')).toHaveLength(1)

    fireQuit()

    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })

  it('does not add a second relaunch when an immediate relaunch already queued one', () => {
    relaunchApp('gpu-fallback')
    scheduleRelaunchOnQuit('admin-restart')
    fireQuit()

    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })

  it('relaunches once the quit actually happens', () => {
    scheduleRelaunchOnQuit('profile-switch')
    expect(appRelaunchMock).not.toHaveBeenCalled()

    fireQuit()

    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })
})

describe('cancelScheduledRelaunch', () => {
  it('withdraws a relaunch when the quit is abandoned, so a later quit is not a surprise restart', () => {
    scheduleRelaunchOnQuit('admin-restart')
    cancelScheduledRelaunch()

    fireQuit()

    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('lets a fresh restart request schedule again after a cancellation', () => {
    scheduleRelaunchOnQuit('admin-restart')
    cancelScheduledRelaunch()
    scheduleRelaunchOnQuit('admin-restart')

    fireQuit()

    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })
})

describe('relaunch during a staged update', () => {
  it('yields to the installer instead of restarting the old version', () => {
    // Relaunching here would restart the OLD bundle and cancel the update this quit applies.
    isMacUpdateInstallInFlightMock.mockReturnValue(true)
    scheduleRelaunchOnQuit('admin-restart')

    fireQuit()

    expect(appRelaunchMock).not.toHaveBeenCalled()
  })
})

describe('abandoned restarts that main never learns about', () => {
  it('does not resurrect a restart on an unrelated quit much later', () => {
    // Main preventDefaults the close and asks the renderer; if the user cancels there, nothing
    // reports back (main-window-close-lifecycle.ts:115), so an explicit cancel cannot be relied on.
    vi.useFakeTimers()
    try {
      scheduleRelaunchOnQuit('admin-restart')
      vi.advanceTimersByTime(6 * 60_000)

      fireQuit()

      expect(appRelaunchMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still relaunches when a slow teardown delays the quit', () => {
    // A real restart can take tens of seconds: 20s quit deadline plus renderer scrollback capture.
    vi.useFakeTimers()
    try {
      scheduleRelaunchOnQuit('admin-restart')
      vi.advanceTimersByTime(60_000)

      fireQuit()

      expect(appRelaunchMock).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('immediate relaunch callers during an install', () => {
  it('yields the relaunch so the installer can own it', () => {
    // GPU fallback and renderer restart follow with app.exit(0) regardless, so the process still
    // exits and the installer relaunches the NEW version. Relaunching here would restart the OLD
    // bundle and cancel the update.
    isMacUpdateInstallInFlightMock.mockReturnValue(true)

    relaunchApp('gpu-fallback')

    expect(appRelaunchMock).not.toHaveBeenCalled()
  })

  it('relaunches normally when no install is in flight', () => {
    isMacUpdateInstallInFlightMock.mockReturnValue(false)

    relaunchApp('gpu-fallback')

    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })
})
