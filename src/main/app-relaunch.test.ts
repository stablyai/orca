import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appRelaunchMock, appExitMock, recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  appRelaunchMock: vi.fn(),
  appExitMock: vi.fn(),
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

vi.mock('electron', () => ({ app: { relaunch: appRelaunchMock, exit: appExitMock } }))
vi.mock('./crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { relaunchAndExitImmediately, relaunchApp } from './app-relaunch'
import { COMMITTED_QUIT_BREADCRUMB_NAME } from './crash-reporting/committed-quit-breadcrumb'
import { _resetHydrateShellPathCache, _setLaunchPathForTests } from './startup/hydrate-shell-path'

beforeEach(() => {
  appRelaunchMock.mockReset()
  appExitMock.mockReset()
  recordDurableCrashBreadcrumbMock.mockReset()
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

describe('relaunchAndExitImmediately', () => {
  // app.exit() fires neither before-quit nor will-quit, so this is the only place the
  // committed-quit crumb can be written for a deliberate restart. Without it the next
  // launch publishes previousMainProcessDiedAbruptly: true and backfills
  // mainProcessDiedAbruptly onto the very reports the GPU crash just created.
  it('closes the launch with a committed-quit crumb before exiting', () => {
    relaunchAndExitImmediately('gpu-fallback', { mode: 'hardware-retry' })

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith(COMMITTED_QUIT_BREADCRUMB_NAME, {
      quitReason: 'relaunch-exit'
    })
    expect(appExitMock).toHaveBeenCalledWith(0)
    expect(recordDurableCrashBreadcrumbMock.mock.invocationCallOrder[0]).toBeLessThan(
      appExitMock.mock.invocationCallOrder[0]
    )
  })

  it('still records the relaunch reason the crash trail already carried', () => {
    relaunchAndExitImmediately('renderer-request')

    expect(recordDurableCrashBreadcrumbMock).toHaveBeenCalledWith('app_relaunch_requested', {
      reason: 'renderer-request'
    })
    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })
})
