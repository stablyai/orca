import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('@electron-toolkit/utils', async () =>
  (await import('./createMainWindow-test-harness')).electronToolkitUtilsMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)
vi.mock('../browser/browser-client-page-renderer-runtime', async () => {
  const harness = await import('./createMainWindow-test-harness')
  return {
    attachBrowserClientPageRenderer: harness.attachClientPageRendererMock,
    retireBrowserClientPageRenderer: harness.retireClientPageRendererMock
  }
})

import { createMainWindow } from './createMainWindow'
import { shouldRecoverRendererAfterProcessGone } from '../crash-reporting/process-gone-classification'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  browserWindowMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

/**
 * Windows launch-failed / exit 18 (win32 10.0.26200, v1.4.198 + v1.4.199).
 *
 * Field bundle qNKP0hy6kIeMczMWzuXsEA, main pid 28400:
 *   t+0.000  render-process-gone launch-failed 18
 *   t+0.268  renderer_recovery_reload           (auto attempt 1)
 *   t+1.086  reload_failed attempt=1 ERR_FAILED -> auto attempt 2
 *   t+1.092  reload_failed attempt=2 ERR_FAILED
 *   t+1.093  renderer_recovery_reload_exhausted recentRecoveryCount=1   <- modal prompt raised
 *   t+1.354  renderer_recovery_reload           <- STARTED BEHIND THE UNANSWERED PROMPT
 *   t+2.226  renderer_recovery_reload           <- and again
 *   t+2.830  render-process-gone launch-failed 18  (breaker now refuses; escalation swallowed)
 *   t+19.83  renderer_recovery_manual_retry     <- user finally answers prompt #1
 *
 * A launch-failed renderer never spawned, so reloading the same webContents can
 * never produce one. `fail()` in renderer-recovery-reload-watchdog.ts guards that
 * with "A pending prompt or crash recovery owns the next reload" -- but `issue()`
 * has no such guard, so every fresh render-process-gone starts another reload
 * behind the modal dialog, silently spends the circuit breaker's budget, and the
 * resulting `crash-loop` escalation is then dropped by `escalate()`'s one-prompt
 * latch. Every bundle in the cluster therefore reports recentRecoveryCount: 1.
 */
describe('renderer recovery reload storm behind an unanswered prompt', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('does not start recovery reloads while a recovery prompt is unanswered', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const windowHandlers: Record<string, (...args: any[]) => void> = {}
      const webContents = {
        id: 143,
        getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
        isDestroyed: vi.fn(() => false),
        on: vi.fn((event, handler) => {
          windowHandlers[event] = handler
        }),
        setZoomLevel: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        invalidate: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        send: vi.fn()
      }
      // The field shape: the load rejects with ERR_FAILED because the renderer never spawned.
      const loadFailure = Object.assign(new Error('ERR_FAILED (-2) loading index.html'), {
        code: 'ERR_FAILED'
      })
      const browserWindowInstance = {
        webContents,
        on: vi.fn((event, handler) => {
          windowHandlers[event] = handler
        }),
        isDestroyed: vi.fn(() => false),
        isMaximized: vi.fn(() => true),
        isFullScreen: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        setSize: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        loadFile: vi.fn(() => Promise.reject(loadFailure)),
        loadURL: vi.fn(() => Promise.reject(loadFailure))
      }
      browserWindowMock.mockImplementation(function () {
        return browserWindowInstance
      })

      const onRendererRecoveryExhausted = vi.fn()
      withPlatform('win32', () => {
        createMainWindow(null, {
          onRendererRecoveryExhausted,
          shouldRecoverRenderer: (details) =>
            shouldRecoverRendererAfterProcessGone({
              reason: details.reason,
              expectedTeardown: 'none'
            })
        })
      })

      const details = {
        reason: 'launch-failed',
        exitCode: 18
      } as Electron.RenderProcessGoneDetails
      const driveLaunchFailure = async (): Promise<void> => {
        windowHandlers['render-process-gone']?.({} as never, details)
        await vi.advanceTimersByTimeAsync(250)
        await vi.advanceTimersByTimeAsync(0)
      }

      await driveLaunchFailure()

      // Initial load + the watchdog's two attempts, both rejecting with ERR_FAILED.
      expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(3)
      expect(onRendererRecoveryExhausted).toHaveBeenCalledTimes(1)
      expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
        expect.objectContaining({ cause: 'reload-stalled', recentRecoveryCount: 1 })
      )

      // The prompt is a native message box; nothing has answered it yet.
      const loadsWhilePromptUnanswered = browserWindowInstance.loadFile.mock.calls.length
      await driveLaunchFailure()
      await driveLaunchFailure()

      // A pending prompt owns the next reload -- no reload may start behind it.
      expect(browserWindowInstance.loadFile).toHaveBeenCalledTimes(loadsWhilePromptUnanswered)

      // Those hidden reloads spend the breaker's budget, so this crash opens it --
      // and the crash-loop verdict is then swallowed by the one-prompt latch.
      await driveLaunchFailure()
      expect(onRendererRecoveryExhausted).toHaveBeenCalledWith(
        expect.objectContaining({ cause: 'crash-loop' })
      )
      // The box on screen cannot be replaced, so the corrected verdict is recorded without stacking a second one.
      expect(onRendererRecoveryExhausted).toHaveBeenLastCalledWith(
        expect.objectContaining({ supersedesStandingPrompt: true, recentRecoveryCount: 3 })
      )
    } finally {
      consoleError.mockRestore()
    }
  })
})
