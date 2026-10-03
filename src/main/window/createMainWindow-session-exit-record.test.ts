import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recordMainSessionExitSyncMock, recordDurableCrashBreadcrumbMock } = vi.hoisted(() => ({
  recordMainSessionExitSyncMock: vi.fn(),
  recordDurableCrashBreadcrumbMock: vi.fn()
}))

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
vi.mock('../crash-reporting/main-session-exit-marker', () => ({
  recordMainSessionExitSync: recordMainSessionExitSyncMock
}))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: recordDurableCrashBreadcrumbMock
}))

import { createMainWindow } from './createMainWindow'
import {
  browserWindowMock,
  resetMainWindowMocks,
  withPlatform
} from './createMainWindow-test-harness'

function openWindow(): Record<string, (...args: unknown[]) => void> {
  const windowHandlers: Record<string, (...args: unknown[]) => void> = {}
  const register = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    windowHandlers[event] = handler
  })
  const browserWindowInstance = {
    webContents: {
      on: vi.fn(),
      setZoomLevel: vi.fn(),
      setBackgroundThrottling: vi.fn(),
      invalidate: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      send: vi.fn()
    },
    on: register,
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
  createMainWindow(null)
  return windowHandlers
}

describe('createMainWindow session exit record', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    recordMainSessionExitSyncMock.mockReset()
    recordDurableCrashBreadcrumbMock.mockReset()
  })

  it('records a Windows session-end exit synchronously', () => {
    const windowHandlers = withPlatform('win32', openWindow)
    expect(recordMainSessionExitSyncMock).not.toHaveBeenCalled()

    windowHandlers['session-end']?.({})

    expect(recordMainSessionExitSyncMock).toHaveBeenCalledOnce()
    expect(recordMainSessionExitSyncMock).toHaveBeenCalledWith('os-session-end')
  })
})
