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
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

describe('createMainWindow voice control shortcut', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('only intercepts the voice control chord while the control feature gate is on', () => {
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
  })
})
