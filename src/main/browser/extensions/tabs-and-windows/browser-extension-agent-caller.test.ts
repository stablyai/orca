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
  app: { prependListener: vi.fn(), off: vi.fn(), getPath: browserMocks.appGetPathMock },
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))

import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { runWithActiveRpcCaller } from '../../../runtime/rpc/callers/active-call'
import { withAgentInputInjection } from '../../cdp/input/agent-input-injection'
import {
  guestNavigationMethods,
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from '../../guest-lifecycle/manager/browser-manager-test-harness'
import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'
import { placeBrowserExtensionCallerTab } from './browser-extension-agent-caller'

const workSession = { name: 'work' }
const otherSession = { name: 'other' }

/** Registers a guest page; `click` delivers an activating input to it. */
function registerPage(browserPageId: string, id: number, worktreeId: string) {
  const on = vi.fn()
  const guest = {
    ...guestNavigationMethods(),
    id,
    session: workSession,
    isDestroyed: vi.fn(() => false),
    isCurrentlyAudible: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    on,
    prependListener: vi.fn(),
    off: vi.fn(),
    openDevTools: vi.fn()
  }
  const previous = browserMocks.webContentsFromIdMock.getMockImplementation()
  browserMocks.webContentsFromIdMock.mockImplementation((lookup: number) =>
    lookup === id ? guest : previous?.(lookup)
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the manager and input tracker call only the methods stubbed above.
  const contents = guest as unknown as Electron.WebContents
  browserManager.attachGuestPolicies(contents)
  browserManager.registerGuest({
    browserPageId,
    worktreeId,
    webContentsId: id,
    rendererWebContentsId
  })
  const onInput = on.mock.calls.find(([event]) => event === 'input-event')?.[1]
  return { contents, click: () => onInput({}, { type: 'mouseUp' }) }
}

function caller(session: typeof workSession, extra: Partial<BrowserExtensionCaller> = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: placement reads session, webContents and userGesture only.
  return { session, browserProfileId: 'work', fromWorker: true, ...extra } as BrowserExtensionCaller
}

beforeEach(() => {
  resetBrowserManagerMocks(browserMocks)
  resetBrowserManagerState()
  browserMocks.webContentsFromIdMock.mockImplementation(() => null)
})

describe('an extension tab set off while an agent drives a page in its profile', () => {
  it("opens in the background in the agent's workspace, unless the user set it off", async () => {
    const userPage = registerPage('user-page', 11, 'wt-user')
    const agentPage = registerPage('agent-page', 12, 'wt-agent')
    const command = runWithActiveRpcCaller({ kind: 'local-cli' }, () =>
      browserManager.beginAgentCommand('agent-page')
    )
    const placeFromWorker = () => placeBrowserExtensionCallerTab(caller(workSession), true)
    const agentPlacement = { active: false, worktreeId: 'wt-agent' }

    expect(placeFromWorker()).toEqual(agentPlacement)
    expect(placeBrowserExtensionCallerTab(caller(otherSession), true)).toEqual({ active: true })
    expect(
      placeBrowserExtensionCallerTab(caller(workSession, { userGesture: true }), true)
    ).toEqual({ active: true })

    userPage.click()
    expect(placeFromWorker()).toEqual({ active: true })
    await withAgentInputInjection(agentPage.contents, async () => agentPage.click())
    expect(placeFromWorker()).toEqual(agentPlacement)

    command.end()
  })
})
