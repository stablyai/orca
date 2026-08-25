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
import { ipcMain } from 'electron'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

function historyBackInput(): Record<string, unknown> {
  const isDarwin = process.platform === 'darwin'
  return {
    type: 'keyDown',
    code: 'ArrowLeft',
    key: 'ArrowLeft',
    meta: isDarwin,
    control: !isDarwin,
    alt: true,
    shift: false
  }
}

describe('createMainWindow spatial pane focus shortcuts', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useRealTimers()
  })

  it('still intercepts worktree history when a terminal is not focused', () => {
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
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const preventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault } as never, historyBackInput() as never)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(webContents.send).toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })

  it('yields worktree-history chords to the renderer while a terminal is focused', () => {
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
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
    browserWindowMock.mockImplementation(function () {
      return browserWindowInstance
    })

    createMainWindow(null)

    const setFocusedListener = vi
      .mocked(ipcMain.on)
      .mock.calls.find(([channel]) => channel === 'ui:setTerminalInputFocused')?.[1]
    expect(setFocusedListener).toBeTypeOf('function')
    setFocusedListener?.({ sender: webContents } as never, true)

    const preventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault } as never, historyBackInput() as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:worktreeHistoryNavigate', 'back')
  })
})
