import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const browserMocks = vi.hoisted(() => ({
  appGetPathMock: vi.fn(() => '/downloads'),
  shellOpenExternalMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  menuBuildFromTemplateMock: vi.fn(),
  guestOffMock: vi.fn(),
  guestOnMock: vi.fn(),
  guestSetBackgroundThrottlingMock: vi.fn(),
  guestSetWindowOpenHandlerMock: vi.fn(),
  guestOpenDevToolsMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  screenGetCursorScreenPointMock: vi.fn(() => ({ x: 0, y: 0 })),
  openPopupWithOriginBarMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: browserMocks.appGetPathMock
  },
  BrowserWindow: {
    fromWebContents: browserMocks.browserWindowFromWebContentsMock
  },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: {
    buildFromTemplate: browserMocks.menuBuildFromTemplateMock
  },
  screen: {
    getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock
  },
  webContents: {
    fromId: browserMocks.webContentsFromIdMock
  }
}))

vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import {
  createDownloadItem,
  getDownloadItemEventHandler,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'

const {
  guestOffMock,
  guestOnMock,
  guestSetBackgroundThrottlingMock,
  guestSetWindowOpenHandlerMock,
  guestOpenDevToolsMock,
  webContentsFromIdMock
} = browserMocks

describe('browserManager', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('queues permission denials and download requests until the guest registers', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 407,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = {
      setSavePath: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      off: vi.fn(),
      cancel: vi.fn(),
      getFilename: vi.fn(() => 'report.csv'),
      getTotalBytes: vi.fn(() => 2048),
      getMimeType: vi.fn(() => 'text/csv'),
      getURL: vi.fn(() => 'https://example.com/report.csv'),
      getReceivedBytes: vi.fn(() => 0)
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.notifyPermissionDenied({
      guestWebContentsId: guest.id,
      permission: 'media',
      rawUrl: 'https://example.com/account'
    })
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: item as never })

    expect(rendererSendMock).not.toHaveBeenCalled()

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    expect(rendererSendMock).toHaveBeenCalledWith('browser:permission-denied', {
      browserPageId: 'browser-1',
      permission: 'media',
      origin: 'https://example.com'
    })
    browserManager.notifyPermissionDenied({
      guestWebContentsId: guest.id,
      permission: 'geolocation',
      rawUrl: ''
    })
    expect(rendererSendMock).toHaveBeenCalledWith('browser:permission-denied', {
      browserPageId: 'browser-1',
      permission: 'geolocation',
      origin: 'unknown'
    })
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({
        browserPageId: 'browser-1',
        filename: 'report.csv',
        origin: 'https://example.com',
        totalBytes: 2048,
        mimeType: 'text/csv',
        savePath: join('/downloads', 'report.csv'),
        status: 'downloading'
      })
    )
    expect(item.setSavePath).toHaveBeenCalledWith(join('/downloads', 'report.csv'))
  })

  it('sets the download save path immediately and reports progress and completion', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 408,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    expect(item.setSavePath).toHaveBeenCalledWith(join('/downloads', 'report.csv'))
    expect(item.on).toHaveBeenCalledWith('updated', expect.any(Function))
    expect(item.once).toHaveBeenCalledWith('done', expect.any(Function))
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-requested',
      expect.objectContaining({
        browserPageId: 'browser-1',
        filename: 'report.csv',
        savePath: join('/downloads', 'report.csv'),
        status: 'downloading'
      })
    )

    vi.mocked(item.getReceivedBytes).mockReturnValue(1024)
    const updatedHandler = getDownloadItemEventHandler(item, 'on', 'updated')
    updatedHandler?.({} as Electron.Event, 'progressing')

    expect(rendererSendMock).toHaveBeenCalledWith('browser:download-progress', {
      browserPageId: 'browser-1',
      downloadId: expect.any(String),
      receivedBytes: 1024,
      totalBytes: 2048,
      state: 'progressing'
    })

    const doneHandler = getDownloadItemEventHandler(item, 'once', 'done')
    doneHandler?.({} as Electron.Event, 'completed')

    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        browserPageId: 'browser-1',
        status: 'completed',
        savePath: join('/downloads', 'report.csv'),
        error: null
      })
    )
  })

  it('flushes started and terminal snapshots for downloads that finish before registration', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 409,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    const doneHandler = getDownloadItemEventHandler(item, 'once', 'done')
    doneHandler?.({} as Electron.Event, 'completed')

    expect(rendererSendMock).not.toHaveBeenCalled()

    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })

    expect(rendererSendMock.mock.calls.map(([channel]) => channel)).toEqual([
      'browser:download-requested',
      'browser:download-finished'
    ])
  })

  it('drops pending download records when an unregistered guest is destroyed', () => {
    const guest = {
      id: 412,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
    webContentsFromIdMock.mockReturnValue(guest)

    browserManager.attachGuestPolicies(guest as never)
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    const managerState = browserManager as unknown as { downloadsById: Map<string, unknown> }
    expect(managerState.downloadsById.size).toBe(1)

    const destroyedHandler = guestOnMock.mock.calls.find(
      ([event]) => event === 'destroyed'
    )?.[1] as (() => void) | undefined
    destroyedHandler?.()

    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(managerState.downloadsById.size).toBe(0)
  })

  it('cancels active downloads when the owning browser tab closes', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 410,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem()
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    browserManager.unregisterGuest('browser-1')

    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        browserPageId: 'browser-1',
        status: 'canceled',
        error: 'Tab closed before download completed.'
      })
    )
  })

  it('reports setSavePath failures without leaving a hidden download running', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 411,
      isDestroyed: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const item = createDownloadItem({
      setSavePath: vi.fn(() => {
        throw new Error('cannot set path')
      }) as never
    })
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })

    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })

    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(rendererSendMock.mock.calls.map(([channel]) => channel)).toEqual([
      'browser:download-requested',
      'browser:download-finished'
    ])
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({
        status: 'failed',
        error: 'Failed to set download destination.'
      })
    )
  })
})
