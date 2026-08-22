import { beforeEach, describe, expect, it, vi } from 'vitest'

const { registerWindowMock, removeWindowMock, noteFocusedMock, getAllWindowsMock } = vi.hoisted(
  () => ({
    registerWindowMock: vi.fn(),
    removeWindowMock: vi.fn(),
    noteFocusedMock: vi.fn(),
    getAllWindowsMock: vi.fn()
  })
)

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
vi.mock('./orca-window-manager', () => ({
  orcaWindowManager: {
    getControlWindow: vi.fn(() => null),
    isTrustedSender: vi.fn(() => false),
    getAllWindows: getAllWindowsMock,
    noteFocused: noteFocusedMock,
    register: registerWindowMock,
    remove: removeWindowMock
  }
}))

import { ipcMain } from 'electron'
import { createMainWindow } from './createMainWindow'
import { browserManager } from '../browser/browser-manager'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'

type Handler = (...args: any[]) => void

function makeWindow(id: number) {
  const windowHandlers = new Map<string, Handler[]>()
  const webContentsHandlers = new Map<string, Handler[]>()
  const webContents = {
    id: id + 100,
    on: vi.fn((event: string, handler: Handler) => {
      webContentsHandlers.set(event, [...(webContentsHandlers.get(event) ?? []), handler])
    }),
    once: vi.fn((event: string, handler: Handler) => {
      webContentsHandlers.set(event, [...(webContentsHandlers.get(event) ?? []), handler])
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    isDevToolsOpened: vi.fn(() => false),
    openDevTools: vi.fn(),
    closeDevTools: vi.fn()
  }
  const instance = {
    id,
    webContents,
    on: vi.fn((event: string, handler: Handler) => {
      windowHandlers.set(event, [...(windowHandlers.get(event) ?? []), handler])
    }),
    once: vi.fn((event: string, handler: Handler) => {
      windowHandlers.set(event, [...(windowHandlers.get(event) ?? []), handler])
    }),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    getSize: vi.fn(() => [1200, 800]),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1200, height: 800 })),
    setSize: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
    loadFile: vi.fn(),
    loadURL: vi.fn()
  }
  return { instance, windowHandlers, webContentsHandlers }
}

describe('createMainWindow multi-window registration', () => {
  beforeEach(() => {
    resetMainWindowMocks()
    registerWindowMock.mockReset()
    removeWindowMock.mockReset()
    noteFocusedMock.mockReset()
    getAllWindowsMock.mockReset()
  })

  it('registers roles and routes native controls by event sender', () => {
    const ipcHandlers = new Map<string, Handler[]>()
    vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
      ipcHandlers.set(channel, [...(ipcHandlers.get(channel) ?? []), handler as Handler])
      return ipcMain
    })
    const first = makeWindow(1)
    const second = makeWindow(2)
    browserWindowMock
      .mockImplementationOnce(function () {
        return first.instance
      })
      .mockImplementationOnce(function () {
        return second.instance
      })

    createMainWindow(null, { deferLoad: true, orcaWindowRole: 'control' } as never)
    createMainWindow(null, { deferLoad: true, orcaWindowRole: 'secondary' } as never)

    expect(registerWindowMock).toHaveBeenNthCalledWith(1, first.instance, 'control')
    expect(registerWindowMock).toHaveBeenNthCalledWith(2, second.instance, 'secondary')

    for (const handler of ipcHandlers.get('window:minimize') ?? []) {
      handler({ sender: second.instance.webContents })
    }

    expect(first.instance.minimize).not.toHaveBeenCalled()
    expect(second.instance.minimize).toHaveBeenCalledOnce()

    first.windowHandlers.get('focus')?.forEach((handler) => handler())
    expect(noteFocusedMock).toHaveBeenCalledWith(1)

    getAllWindowsMock.mockReturnValue([second.instance])
    first.windowHandlers.get('closed')?.forEach((handler) => handler())
    expect(removeWindowMock).toHaveBeenCalledWith(1)
    expect(browserManager.setDictationShortcutForwardingPredicate).not.toHaveBeenLastCalledWith(
      null
    )
  })

  it('can create a hidden secondary at explicit bounds without persisting primary bounds', () => {
    vi.useFakeTimers()
    const secondary = makeWindow(2)
    browserWindowMock.mockImplementation(function () {
      return secondary.instance
    })
    const updateUI = vi.fn()
    const store = {
      getUI: vi.fn(() => ({
        windowBounds: { x: 10, y: 20, width: 1000, height: 700 },
        windowMaximized: true
      })),
      getSettings: vi.fn(() => ({})),
      updateUI
    }
    const initialBounds = { x: 1500, y: 80, width: 900, height: 700 }

    createMainWindow(
      store as never,
      {
        deferLoad: true,
        initialBounds,
        orcaWindowRole: 'secondary',
        persistPrimaryBounds: false,
        restorePrimaryBounds: false,
        showWhenReady: false
      } as never
    )

    expect(browserWindowMock).toHaveBeenCalledWith(expect.objectContaining(initialBounds))
    secondary.windowHandlers.get('ready-to-show')?.forEach((handler) => handler())
    expect(secondary.instance.show).not.toHaveBeenCalled()

    secondary.windowHandlers.get('resize')?.forEach((handler) => handler())
    vi.runAllTimers()
    expect(updateUI).not.toHaveBeenCalledWith(
      expect.objectContaining({ windowBounds: expect.anything() })
    )
    vi.useRealTimers()
  })
})
