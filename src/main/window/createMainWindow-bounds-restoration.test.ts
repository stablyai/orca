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

function installBrowserWindowFixture(): void {
  const webContents = {
    on: vi.fn(),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn()
  }
  browserWindowMock.mockImplementation(function () {
    return {
      webContents,
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      isFullScreen: vi.fn(() => false),
      getSize: vi.fn(() => [1200, 800]),
      setSize: vi.fn(),
      setWindowButtonPosition: vi.fn(),
      maximize: vi.fn(),
      show: vi.fn(),
      loadFile: vi.fn(),
      loadURL: vi.fn()
    }
  })
}

function createStore(windowBounds: Electron.Rectangle) {
  return {
    getUI: () => ({ windowBounds }) as never,
    getSettings: () => ({ windowBackgroundBlur: false }) as never,
    updateUI: vi.fn()
  }
}

describe('main window bounds restoration', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    installBrowserWindowFixture()
  })

  it('restores an intentionally side-parked window with a grabbable titlebar slice', () => {
    const windowBounds = { x: -1110, y: 0, width: 1200, height: 800 }

    createMainWindow(createStore(windowBounds) as never)

    expect(browserWindowMock).toHaveBeenCalledWith(expect.objectContaining(windowBounds))
  })

  it('discards a saved window with only a titlebar sliver visible', () => {
    createMainWindow(createStore({ x: -1180, y: 0, width: 1200, height: 800 }) as never)

    expect(browserWindowMock).toHaveBeenCalledWith(expect.not.objectContaining({ x: -1180, y: 0 }))
  })
})
