import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, recordUpdaterLifecycleMock, recordMainSessionExitSyncMock } = vi.hoisted(() => ({
  appMock: { exit: vi.fn() },
  recordUpdaterLifecycleMock: vi.fn(),
  recordMainSessionExitSyncMock: vi.fn()
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./crash-reporting/main-session-exit-marker', () => ({
  recordMainSessionExitSync: recordMainSessionExitSyncMock
}))

import {
  armUpdateInstallExitWatchdog,
  disarmUpdateInstallExitWatchdog,
  UPDATE_INSTALL_EXIT_TIMEOUT_MS
} from './update-install-exit-watchdog'

const originalPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

describe('update install exit watchdog', () => {
  beforeEach(() => {
    setPlatform('darwin')
    vi.useFakeTimers()
    appMock.exit.mockClear()
    recordUpdaterLifecycleMock.mockClear()
    recordMainSessionExitSyncMock.mockClear()
  })

  afterEach(() => {
    disarmUpdateInstallExitWatchdog()
    vi.useRealTimers()
    setPlatform(originalPlatform)
  })

  it('force-exits with code 0 when the deadline passes', () => {
    armUpdateInstallExitWatchdog()

    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS - 1)
    expect(appMock.exit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(appMock.exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'install_exit_watchdog_fired',
      { timeoutMs: UPDATE_INSTALL_EXIT_TIMEOUT_MS },
      expect.objectContaining({ level: 'warn' })
    )
  })

  it('records an update-install exit before forcing exit so the next launch is not flagged unclean', () => {
    armUpdateInstallExitWatchdog()
    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS - 1)
    expect(recordMainSessionExitSyncMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(recordMainSessionExitSyncMock).toHaveBeenCalledExactlyOnceWith('update-install')
    expect(recordMainSessionExitSyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      appMock.exit.mock.invocationCallOrder[0]
    )
  })

  it('re-arming does not extend the original deadline', () => {
    armUpdateInstallExitWatchdog()
    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS - 1)

    armUpdateInstallExitWatchdog()
    vi.advanceTimersByTime(1)

    expect(appMock.exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('disarm cancels the forced exit', () => {
    armUpdateInstallExitWatchdog()
    disarmUpdateInstallExitWatchdog()

    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS * 2)
    expect(appMock.exit).not.toHaveBeenCalled()
    expect(recordMainSessionExitSyncMock).not.toHaveBeenCalled()
  })

  it('can be armed again after a disarm (install recovery then retry)', () => {
    armUpdateInstallExitWatchdog()
    disarmUpdateInstallExitWatchdog()
    armUpdateInstallExitWatchdog()

    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS)
    expect(appMock.exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('records the update-install exit at commit on Windows, where the installer kills the process', () => {
    setPlatform('win32')
    armUpdateInstallExitWatchdog()

    expect(recordMainSessionExitSyncMock).toHaveBeenCalledExactlyOnceWith('update-install')
    expect(appMock.exit).not.toHaveBeenCalled()
  })

  it('records at commit only once when re-armed on Windows', () => {
    setPlatform('win32')
    armUpdateInstallExitWatchdog()
    armUpdateInstallExitWatchdog()

    expect(recordMainSessionExitSyncMock).toHaveBeenCalledOnce()
  })
})
