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
    prependListener: vi.fn(),
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
import { withAgentInputInjection } from '../../../cdp/input/agent-input-injection'
import { runWithActiveRpcCaller } from '../../../../runtime/rpc/callers/active-call'
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

  // #36804: headless serve pages have no renderer to own Orca's tab model.
  // orcad's Electron browser registers pages without a workspace, so there is no tab list to open into.

  it("opens an agent's link behind the user's tab, and the user's own click in front", async () => {
    const rendererSendMock = vi.fn()
    const guest = {
      ...guestNavigationMethods(),
      id: 145,
      isDestroyed: vi.fn(() => false),
      isCurrentlyAudible: vi.fn(() => false),
      getType: vi.fn(() => 'webview'),
      setBackgroundThrottling: guestSetBackgroundThrottlingMock,
      setWindowOpenHandler: guestSetWindowOpenHandlerMock,
      setIgnoreMenuShortcuts: vi.fn(),
      on: guestOnMock,
      prependListener: vi.fn(),
      off: guestOffMock,
      openDevTools: guestOpenDevToolsMock
    }
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === guest.id) {
        return guest
      }
      if (id === rendererWebContentsId) {
        return { id, isDestroyed: vi.fn(() => false), send: rendererSendMock }
      }
      return null
    })
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'browser-1',
      webContentsId: guest.id,
      rendererWebContentsId
    })
    const handler: (details: {
      url: string
      frameName: string
      features: string
      disposition: string
    }) => unknown = guestSetWindowOpenHandlerMock.mock.calls[0][0]
    const inputEventHandler = guestOnMock.mock.calls.find(([event]) => event === 'input-event')?.[1]
    const openLink = (url: string): void => {
      handler({ url, frameName: '', features: '', disposition: 'foreground-tab' })
    }
    const command = runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('browser-1')
    )

    await withAgentInputInjection(guest as never, async () => {
      inputEventHandler({}, { type: 'mouseUp' })
    })
    openLink('https://docs.example.com/agent')
    inputEventHandler({}, { type: 'mouseUp' })
    openLink('https://docs.example.com/user')
    command.end()

    expect(
      rendererSendMock.mock.calls.filter(([channel]) => channel === 'browser:open-link-in-orca-tab')
    ).toEqual([
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://docs.example.com/agent', activate: false }
      ],
      [
        'browser:open-link-in-orca-tab',
        { browserPageId: 'browser-1', url: 'https://docs.example.com/user' }
      ]
    ])
  })
})
