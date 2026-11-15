import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    prependOnceListener: vi.fn(),
    off: vi.fn(),
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
import { respondToBrowserPagePrompt } from '../../prompts/browser-page-prompts'
import {
  guestNavigationMethods,
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
  webContentsFromIdMock,
  shellOpenExternalMock
} = browserMocks

describe('browserManager page prompt routing', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  it('asks before a page hands a link to another app, naming the frame that asked', () => {
    const rendererSendMock = vi.fn()
    const guest = {
      ...guestNavigationMethods(),
      id: 107,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      getURL: vi.fn(() => 'https://trusted.example/home'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      on: guestOnMock,
      prependListener: vi.fn(),
      once: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    const renderer = {
      id: rendererWebContentsId,
      isDestroyed: () => false,
      send: rendererSendMock,
      on: vi.fn(),
      off: vi.fn()
    }
    shellOpenExternalMock.mockResolvedValue(undefined)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === guest.id ? guest : id === rendererWebContentsId ? renderer : null
    )
    browserManager.attachGuestPolicies(webContentsFromIdMock(guest.id))
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const prompts = (): { requestId: string; scheme: string; origin: string | null }[] =>
      rendererSendMock.mock.calls
        .filter(([channel]) => channel === 'browser:page-prompt-requested')
        .map(([, request]) => ({ requestId: request.requestId, ...request.details }))
    const answerLatest = (open: boolean): void => {
      void respondToBrowserPagePrompt(webContentsFromIdMock(rendererWebContentsId), {
        requestId: prompts().at(-1)!.requestId,
        answer: open ? true : null
      })
    }
    const untrustedFrame = { url: 'https://untrusted.example/ad', isDestroyed: () => false }
    // Cancel quiets prompts until fresh input arrives.
    const clickInPage = (): void => {
      for (const [event, listener] of guestOnMock.mock.calls) {
        if (event === 'input-event') {
          listener({}, { type: 'mouseDown' })
        }
      }
    }

    const windowOpenHandler = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    expect(
      windowOpenHandler({
        url: 'mailto:help@example.com',
        referrer: { url: untrustedFrame.url, policy: 'default' }
      })
    ).toEqual({ action: 'deny' })
    expect(prompts().at(-1)).toMatchObject({
      scheme: 'mailto',
      origin: 'https://untrusted.example'
    })
    expect(rendererSendMock).not.toHaveBeenCalledWith('browser:popup', expect.anything())
    answerLatest(false)
    clickInPage()
    // An absent frame referrer must not be credited to the top-level site.
    windowOpenHandler({
      url: 'mailto:help@example.com',
      referrer: { url: '', policy: 'no-referrer' }
    })
    expect(prompts().at(-1)).toMatchObject({ origin: null })
    answerLatest(false)
    clickInPage()
    expect(shellOpenExternalMock).not.toHaveBeenCalled()

    const willNavigate = guestOnMock.mock.calls.find(([event]) => event === 'will-navigate')?.[1]
    const preventDefault = vi.fn()
    willNavigate({ preventDefault, initiator: untrustedFrame }, 'zoommtg://zoom.us/join?confno=1')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(prompts().at(-1)).toMatchObject({
      scheme: 'zoommtg',
      origin: 'https://untrusted.example'
    })
    answerLatest(true)
    expect(shellOpenExternalMock).toHaveBeenCalledWith('zoommtg://zoom.us/join?confno=1')
    willNavigate({ preventDefault, initiator: null }, 'zoommtg://zoom.us/join?confno=2')
    expect(prompts().at(-1)).toMatchObject({ origin: null })
    answerLatest(false)
  })
})
