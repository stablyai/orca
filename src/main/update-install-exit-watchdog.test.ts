import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appMock, recordUpdaterLifecycleMock, recordAgentSessionRuntimeEndMock } = vi.hoisted(
  () => ({
    appMock: { exit: vi.fn() },
    recordUpdaterLifecycleMock: vi.fn(),
    recordAgentSessionRuntimeEndMock: vi.fn()
  })
)

vi.mock('electron', () => ({ app: appMock }))
vi.mock('./updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))
vi.mock('./runtime/agent-session-runtime-end-record', () => ({
  recordAgentSessionRuntimeEnd: recordAgentSessionRuntimeEndMock
}))

import {
  armUpdateInstallExitWatchdog,
  disarmUpdateInstallExitWatchdog,
  UPDATE_INSTALL_EXIT_TIMEOUT_MS
} from './update-install-exit-watchdog'

describe('update install exit watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    appMock.exit.mockClear()
    recordUpdaterLifecycleMock.mockClear()
    recordAgentSessionRuntimeEndMock.mockClear()
  })

  afterEach(() => {
    disarmUpdateInstallExitWatchdog()
    vi.useRealTimers()
  })

  it('force-exits with code 0 when the deadline passes', () => {
    armUpdateInstallExitWatchdog()

    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS - 1)
    expect(appMock.exit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(appMock.exit).toHaveBeenCalledExactlyOnceWith(0)
    // A wedged teardown may not have reached its own record of the update.
    expect(recordAgentSessionRuntimeEndMock).toHaveBeenCalledExactlyOnceWith('update')
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'install_exit_watchdog_fired',
      { timeoutMs: UPDATE_INSTALL_EXIT_TIMEOUT_MS },
      expect.objectContaining({ level: 'warn' })
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
  })

  it('can be armed again after a disarm (install recovery then retry)', () => {
    armUpdateInstallExitWatchdog()
    disarmUpdateInstallExitWatchdog()
    armUpdateInstallExitWatchdog()

    vi.advanceTimersByTime(UPDATE_INSTALL_EXIT_TIMEOUT_MS)
    expect(appMock.exit).toHaveBeenCalledExactlyOnceWith(0)
  })
})
