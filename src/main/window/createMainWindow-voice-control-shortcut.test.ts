import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { createMainWindow } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/process-exits/expected-teardown-state'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

describe('createMainWindow voice control shortcut', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('intercepts the voice control chord only with the gate on, and only where voice.control is bound (macOS by default)', () => {
    const windowHandlers: Record<string, (...args: any[]) => void> = {}
    const webContents = {
      on: vi.fn((event, handler) => {
        windowHandlers[event] = handler
      }),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      setWebRTCIPHandlingPolicy: vi.fn(),
      isDevToolsOpened: vi.fn(),
      openDevTools: vi.fn(),
      closeDevTools: vi.fn()
    }
    const browserWindowInstance = {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => true),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(() => Promise.resolve()),
      loadURL: vi.fn(() => Promise.resolve())
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    const voice: { enabled: boolean; sttModel: string; control: { enabled: boolean } } = {
      enabled: true,
      sttModel: 'test-model',
      control: { enabled: false }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial deps mock; the shortcut path reads only getSettings().voice.control.enabled and never touches UI state.
    createMainWindow({
      getUI: () => ({}),
      getSettings: () => ({ windowBackgroundBlur: false, voice }),
      updateUI: vi.fn()
    } as never)

    const isDarwin = process.platform === 'darwin'
    const controlInput = {
      type: 'keyDown',
      code: 'KeyV',
      key: 'v',
      meta: isDarwin,
      control: !isDarwin,
      alt: false,
      shift: true
    }

    const disabledPreventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault: disabledPreventDefault }, controlInput)
    expect(disabledPreventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:voiceControlToggle')

    voice.control.enabled = true
    const enabledPreventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault: enabledPreventDefault }, controlInput)
    if (isDarwin) {
      expect(enabledPreventDefault).toHaveBeenCalledTimes(1)
      expect(webContents.send).toHaveBeenCalledWith('ui:voiceControlToggle')

      webContents.send.mockClear()
      const repeatPreventDefault = vi.fn()
      windowHandlers['before-input-event'](
        { preventDefault: repeatPreventDefault },
        { ...controlInput, isAutoRepeat: true }
      )
      expect(repeatPreventDefault).toHaveBeenCalledTimes(1)
      expect(webContents.send).not.toHaveBeenCalled()
    } else {
      // The default binding is darwin-only — off macOS Ctrl+Shift+V is terminal paste
      // (pinned cross-platform in window-shortcut-policy-voice-control.test.ts), so even
      // with the gate on the chord passes through unintercepted.
      expect(enabledPreventDefault).not.toHaveBeenCalled()
      expect(webContents.send).not.toHaveBeenCalledWith('ui:voiceControlToggle')
    }
  })
})
