import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  getFocusedWebContentsMock,
  resetMainWindowMocks
} from './createMainWindow-test-harness'

const CMD_V = {
  type: 'keyDown',
  code: 'KeyV',
  key: 'v',
  meta: true,
  control: false,
  alt: false,
  shift: false
}

function mountMainWindow() {
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
    setWindowButtonPosition: vi.fn(),
    maximize: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn()
  }
  browserWindowMock.mockImplementation(function () {
    return browserWindowInstance
  })

  createMainWindow(null)

  return { windowHandlers, webContents }
}

describe('createMainWindow macOS Cmd+V ownership', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    // Why: pin darwin — on a Linux CI runner the macOS-only branch is never entered.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('claims Cmd+V for Orca paste ownership when this renderer holds focus', () => {
    const { windowHandlers, webContents } = mountMainWindow()
    getFocusedWebContentsMock.mockReturnValue(webContents)

    const preventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault } as never, CMD_V as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(webContents.send).toHaveBeenCalledWith('ui:appMenuPaste')
  })

  it('leaves Cmd+V to DevTools when the DevTools console holds focus', () => {
    const { windowHandlers, webContents } = mountMainWindow()
    getFocusedWebContentsMock.mockReturnValue({ paste: vi.fn() })

    const preventDefault = vi.fn()
    windowHandlers['before-input-event']({ preventDefault } as never, CMD_V as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith('ui:appMenuPaste')
  })
})
