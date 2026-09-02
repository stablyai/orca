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

import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import {
  browserWindowMock,
  powerMonitorOnMock,
  powerMonitorRemoveListenerMock,
  resetMainWindowMocks
} from './createMainWindow-test-harness'

describe('createMainWindow', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  describe('system resume relay', () => {
    function setupResumeWindow() {
      const windowHandlers: Record<string, (...args: any[]) => void> = {}
      const webContents = {
        on: vi.fn(),
        setZoomLevel: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        invalidate: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        send: vi.fn(),
        isDestroyed: vi.fn(() => false),
        id: 1
      }
      const instance = {
        webContents,
        on: vi.fn((event: string, handler: (...args: any[]) => void) => {
          windowHandlers[event] = handler
        }),
        isDestroyed: vi.fn(() => false),
        // Why: maximized keeps forceRepaint from scheduling its size-nudge timer.
        isMaximized: vi.fn(() => true),
        isFullScreen: vi.fn(() => false),
        getSize: vi.fn(() => [1200, 800]),
        setSize: vi.fn(),
        maximize: vi.fn(),
        show: vi.fn(),
        loadFile: vi.fn(),
        loadURL: vi.fn()
      }
      browserWindowMock.mockImplementation(function () {
        return instance
      })
      return { windowHandlers, webContents, instance }
    }

    function getPowerResumeListener(): () => void {
      const resumeCall = powerMonitorOnMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'resume'
      )
      if (!resumeCall) {
        throw new Error('missing powerMonitor resume listener')
      }
      return resumeCall[1] as () => void
    }

    it('relays powerMonitor resume to the live window and forces a repaint', () => {
      const { webContents } = setupResumeWindow()
      createMainWindow(null)
      const onResume = getPowerResumeListener()
      webContents.send.mockClear()
      webContents.invalidate.mockClear()

      onResume()

      expect(webContents.send).toHaveBeenCalledWith('system:resumed')
      expect(webContents.invalidate).toHaveBeenCalledTimes(1)
    })

    it('does not send the resume event once the window is destroyed', () => {
      const { webContents, instance } = setupResumeWindow()
      createMainWindow(null)
      const onResume = getPowerResumeListener()
      instance.isDestroyed.mockReturnValue(true)
      webContents.send.mockClear()
      webContents.invalidate.mockClear()

      onResume()

      expect(webContents.send).not.toHaveBeenCalled()
      expect(webContents.invalidate).not.toHaveBeenCalled()
    })

    it('does not send the resume event once webContents is destroyed', () => {
      const { webContents } = setupResumeWindow()
      createMainWindow(null)
      const onResume = getPowerResumeListener()
      webContents.isDestroyed.mockReturnValue(true)
      webContents.send.mockClear()
      webContents.invalidate.mockClear()

      onResume()

      expect(webContents.send).not.toHaveBeenCalled()
      expect(webContents.invalidate).not.toHaveBeenCalled()
    })

    it('removes the powerMonitor resume listener when the window closes', () => {
      const { windowHandlers } = setupResumeWindow()
      createMainWindow(null)
      const onResume = getPowerResumeListener()

      windowHandlers.closed()

      expect(powerMonitorRemoveListenerMock).toHaveBeenCalledWith('resume', onResume)
    })
  })
})
