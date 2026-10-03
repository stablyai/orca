import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appRelaunchMock,
  labelMainSessionExitMock,
  recordDurableCrashBreadcrumbMock,
  recordMainSessionExitSyncMock
} = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  labelMainSessionExitMock: vi.fn(),
  recordDurableCrashBreadcrumbMock: vi.fn(),
  recordMainSessionExitSyncMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { relaunch: appRelaunchMock } }))
vi.mock('./crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))
vi.mock('./crash-reporting/main-session-exit-marker', () => ({
  labelMainSessionExit: labelMainSessionExitMock,
  recordMainSessionExitSync: recordMainSessionExitSyncMock
}))

import { relaunchApp } from './app-relaunch'
import { _resetHydrateShellPathCache, _setLaunchPathForTests } from './startup/hydrate-shell-path'

beforeEach(() => {
  appRelaunchMock.mockReset()
  recordDurableCrashBreadcrumbMock.mockReset()
  recordMainSessionExitSyncMock.mockReset()
  labelMainSessionExitMock.mockReset()
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
    relaunchApp('gpu-fallback', 'app-exit', { processReason: 'crashed', exitCode: 5 })

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

  it('records a clean relaunch exit before scheduling an app.exit() relaunch', () => {
    relaunchApp('renderer-request', 'app-exit')

    // Why before relaunch: app.exit(0) skips will-quit.
    expect(labelMainSessionExitMock).not.toHaveBeenCalled()
    expect(recordMainSessionExitSyncMock).toHaveBeenCalledOnce()
    expect(recordMainSessionExitSyncMock).toHaveBeenCalledWith('relaunch')
    expect(recordMainSessionExitSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      appRelaunchMock.mock.invocationCallOrder[0]
    )
  })

  it('only labels an app.quit() relaunch so will-quit commits it after teardown', () => {
    relaunchApp('profile-switch', 'app-quit')

    expect(recordMainSessionExitSyncMock).not.toHaveBeenCalled()
    expect(labelMainSessionExitMock).toHaveBeenCalledOnce()
    expect(labelMainSessionExitMock).toHaveBeenCalledWith('relaunch')
    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })

  it('does not carry Orca PATH seeds into the replacement process', () => {
    process.env.PATH = '/seeded/newest-nvm/bin:/usr/bin'
    _setLaunchPathForTests('/usr/bin')
    let inheritedPath: string | undefined
    appRelaunchMock.mockImplementation(() => {
      inheritedPath = process.env.PATH
    })

    relaunchApp('renderer-request', 'app-exit')

    expect(inheritedPath).toBe('/usr/bin')
    expect(process.env.PATH).toBe('/seeded/newest-nvm/bin:/usr/bin')
  })
})
