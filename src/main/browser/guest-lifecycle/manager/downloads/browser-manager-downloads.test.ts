import { EventEmitter } from 'node:events'
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

vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from '../browser-manager'
import { browserDownloadDestinationReservations } from '../../../downloads/browser-download-destination'
import { handleWillDownload } from '../../../downloads/browser-session-download-policy'
import {
  createDownloadItem,
  getDownloadItemEventHandler,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../browser-manager-test-harness'

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

  it("saves the page's next download where an agent asked and reports when it finishes", async () => {
    webContentsFromIdMock.mockReturnValue(null)
    const agentPath = join('/work', 'out', 'report.csv')
    const claim = browserManager.claimNextDownload(414, agentPath)

    const claimed = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: 414, item: claimed })
    await expect(claim.started).resolves.toBe(true)
    expect(claimed.setSavePath).toHaveBeenCalledWith(agentPath)

    const doneEvent = { preventDefault: () => {}, defaultPrevented: false }
    getDownloadItemEventHandler(claimed, 'once', 'done')?.(doneEvent, 'completed')
    await expect(claim.finished).resolves.toMatchObject({
      status: 'completed',
      savePath: agentPath
    })

    const next = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: 414, item: next })
    expect(next.setSavePath).toHaveBeenCalledWith(join('/downloads', 'report.csv'))
    claim.release()
  })

  it('flushes started and terminal snapshots for downloads that finish before registration', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      id: 409,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
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

    // Registration also reports audio state; only download sends matter here.
    expect(
      rendererSendMock.mock.calls
        .map(([channel]) => channel)
        .filter((channel) => channel.startsWith('browser:download-'))
    ).toEqual(['browser:download-requested', 'browser:download-finished'])
  })

  it('fails a download waiting for manual resume and releases its resources', async () => {
    const rendererSendMock = vi.fn()
    const item = createDownloadItem({
      getState: () => 'interrupted',
      canResume: () => true
    })
    const guest = {
      id: 420,
      isDestroyed: () => false,
      isCurrentlyAudible: () => false,
      getType: () => 'webview',
      on: guestOnMock,
      off: guestOffMock,
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock
    }
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id ? guest : { isDestroyed: () => false, send: rendererSendMock }
    )
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item })
    const event = { preventDefault: () => {}, defaultPrevented: false }
    getDownloadItemEventHandler(item, 'on', 'updated')?.(event, 'interrupted')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(item.cancel).toHaveBeenCalledTimes(1)
    // Registration also reports audio state; only download sends matter here.
    expect(
      rendererSendMock.mock.calls
        .map(([channel]) => channel)
        .filter((channel) => channel.startsWith('browser:download-'))
    ).toEqual(['browser:download-requested', 'browser:download-finished'])
    expect(rendererSendMock).toHaveBeenCalledWith(
      'browser:download-finished',
      expect.objectContaining({ status: 'failed', error: 'Download was interrupted.' })
    )
    const managerState = browserManager as unknown as { downloadsById: Map<string, unknown> }
    expect(managerState.downloadsById.size).toBe(0)
    expect(browserDownloadDestinationReservations.reserve('report.csv').filename).toBe('report.csv')
  })

  it("keeps a later download's file when one reserved before a reset finishes after it", () => {
    webContentsFromIdMock.mockReturnValue(null)
    const item = createDownloadItem()
    browserManager.handleGuestWillDownload({ guestWebContentsId: 430, item })
    browserDownloadDestinationReservations.clear()
    expect(browserDownloadDestinationReservations.reserve('report.csv').filename).toBe('report.csv')

    getDownloadItemEventHandler(item, 'once', 'done')?.({} as Electron.Event, 'cancelled')
    expect(browserDownloadDestinationReservations.reserve('report.csv').filename).toBe(
      'report (1).csv'
    )
  })

  describe('items a will-download listener refuses', () => {
    // What Electron's will-download event records: whether a listener refused the item.
    function willDownloadEvent(): { defaultPrevented: boolean; preventDefault: () => void } {
      return {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        }
      }
    }

    // The session policy, with a refusing listener before or after it, as Electron runs them.
    function emitWillDownload(refuse: 'before' | 'after', item: Electron.DownloadItem, id: number) {
      const session = new EventEmitter()
      const refuser = (event: Electron.Event): void => event.preventDefault()
      session.on('will-download', refuse === 'before' ? refuser : handleWillDownload)
      session.on('will-download', refuse === 'before' ? handleWillDownload : refuser)
      session.emit('will-download', willDownloadEvent(), item, { id })
    }

    function guestFor(id: number, rendererSendMock: ReturnType<typeof vi.fn>) {
      const guest = {
        id,
        isDestroyed: () => false,
        isCurrentlyAudible: () => false,
        getType: () => 'webview',
        on: guestOnMock,
        off: guestOffMock,
        setBackgroundThrottling: guestSetBackgroundThrottlingMock,
        setWindowOpenHandler: guestSetWindowOpenHandlerMock
      }
      webContentsFromIdMock.mockImplementation((wanted: number) =>
        wanted === id ? guest : { isDestroyed: () => false, send: rendererSendMock }
      )
      browserManager.attachGuestPolicies(guest as never)
      return guest
    }

    const register = (id: number): boolean =>
      browserManager.registerGuest({
        browserPageId: 'browser-1',
        webContentsId: id,
        rendererWebContentsId
      })
    const downloadSends = (send: ReturnType<typeof vi.fn>): string[] =>
      send.mock.calls.map(([channel]) => channel).filter((c) => c.startsWith('browser:download-'))

    it('takes no item an earlier listener refused, and leaves an agent claim waiting', () => {
      const send = vi.fn()
      const guest = guestFor(440, send)
      const claim = browserManager.claimNextDownload(guest.id, join('/work', 'claimed.csv'))
      const item = createDownloadItem()
      emitWillDownload('before', item, guest.id)

      expect(item.setSavePath).not.toHaveBeenCalled()
      register(guest.id)
      expect(downloadSends(send)).toEqual([])
      const next = createDownloadItem()
      browserManager.handleGuestWillDownload({ guestWebContentsId: guest.id, item: next })
      expect(next.setSavePath).toHaveBeenCalledWith(join('/work', 'claimed.csv'))
      claim.release()
    })

    it('ends and forgets an item a later listener refused before its page registered', async () => {
      const send = vi.fn()
      const guest = guestFor(441, send)
      const item = createDownloadItem()
      emitWillDownload('after', item, guest.id)
      await Promise.resolve()

      expect(item.off).toHaveBeenCalledWith('done', expect.any(Function))
      expect(browserDownloadDestinationReservations.reserve('report.csv').filename).toBe(
        'report.csv'
      )
      register(guest.id)
      expect(downloadSends(send)).toEqual([])
    })

    it("ends the row of an item a later listener refused on a registered tab, and tells the agent's claim", async () => {
      const send = vi.fn()
      const guest = guestFor(442, send)
      register(guest.id)
      const claim = browserManager.claimNextDownload(guest.id, join('/work', 'claimed.csv'))
      emitWillDownload('after', createDownloadItem(), guest.id)
      await Promise.resolve()

      expect(downloadSends(send)).toEqual([
        'browser:download-requested',
        'browser:download-finished'
      ])
      expect(send).toHaveBeenCalledWith(
        'browser:download-finished',
        expect.objectContaining({ status: 'failed', error: null })
      )
      await expect(claim.finished).resolves.toMatchObject({ status: 'failed' })
    })
  })
})
