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
  app: { getPath: browserMocks.appGetPathMock },
  BrowserWindow: { fromWebContents: browserMocks.browserWindowFromWebContentsMock },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: browserMocks.shellOpenExternalMock },
  Menu: { buildFromTemplate: browserMocks.menuBuildFromTemplateMock },
  screen: { getCursorScreenPoint: browserMocks.screenGetCursorScreenPointMock },
  webContents: { fromId: browserMocks.webContentsFromIdMock }
}))
vi.mock('./popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from './browser-manager'
import { resetBrowserManagerMocks, resetBrowserManagerState } from './browser-manager-test-harness'
import { getWorkspaceDocPageGuest } from './doc-preview-guest-policy'
import { mintDocPreviewGrant, revokeAllDocPreviewGrants } from './doc-preview-grant-registry'
import { buildDocPreviewUrl } from '../../shared/doc-preview-scheme'

type GuestFake = {
  id: number
  url: string
  listeners: Map<string, ((...args: never[]) => void)[]>
  windowOpenHandler: ((details: { url: string; frameName: string }) => unknown) | null
  webRtcPolicy: string | null
  isDestroyed: () => boolean
  isFocused: () => boolean
  getURL: () => string
  getType: () => string
  setBackgroundThrottling: (value: boolean) => void
  setWebRTCIPHandlingPolicy: (policy: string) => void
  setWindowOpenHandler: (handler: (details: { url: string; frameName: string }) => unknown) => void
  executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn>
  debugger: {
    isAttached: () => boolean
    attach: ReturnType<typeof vi.fn>
    sendCommand: ReturnType<typeof vi.fn>
  }
  on: (event: string, listener: (...args: never[]) => void) => void
  once: (event: string, listener: (...args: never[]) => void) => void
  off: (event: string, listener: (...args: never[]) => void) => void
}

function createGuest(id: number, url: string): GuestFake {
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const guest: GuestFake = {
    id,
    url,
    listeners,
    windowOpenHandler: null,
    webRtcPolicy: null,
    isDestroyed: () => false,
    isFocused: () => true,
    getURL: () => guest.url,
    getType: () => 'webview',
    setBackgroundThrottling: vi.fn(),
    setWebRTCIPHandlingPolicy: (policy: string) => {
      guest.webRtcPolicy = policy
    },
    setWindowOpenHandler: (handler) => {
      guest.windowOpenHandler = handler
    },
    executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined),
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined)
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    once: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    off: (event, listener) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((entry) => entry !== listener)
      )
    }
  }
  return guest
}

function listenerCount(guest: GuestFake, event: string): number {
  return guest.listeners.get(event)?.length ?? 0
}

/** Drives the guest's own will-navigate listeners and reports whether they refused. */
function navigateTo(guest: GuestFake, url: string): boolean {
  let prevented = false
  const event = { preventDefault: () => (prevented = true) } as never
  for (const listener of guest.listeners.get('will-navigate') ?? []) {
    ;(listener as (event: unknown, url: string) => void)(event, url)
  }
  return prevented
}

const host = { id: 5001, send: vi.fn() } as unknown as Electron.WebContents

beforeEach(() => {
  resetBrowserManagerMocks(browserMocks)
  resetBrowserManagerState()
  revokeAllDocPreviewGrants()
  browserMocks.guestSetBackgroundThrottlingMock.mockReturnValue(undefined)
})

describe('guest policy profiles', () => {
  function attachPreviewGuest(id = 301): {
    guest: GuestFake
    grantId: string
    browserPageId: string
  } {
    const browserPageId = `doc-page-${id}`
    const grant = mintDocPreviewGrant({
      owner: { kind: 'ssh', connectionId: 'ssh-1' },
      root: '/home/alice/docs',
      entryRelativePath: 'index.html',
      browserPageId
    })
    const guest = createGuest(id, buildDocPreviewUrl(grant.id, 'index.html'))
    browserManager.attachGuestPolicies(guest as never, null, { profile: 'workspace-doc', host })
    return { guest, grantId: grant.id, browserPageId }
  }

  // The presence half of every absence below: a browsing guest observably takes all of it through
  // the same method, so a profile that fenced nothing — or an attach path that stopped installing
  // anything at all — cannot pass these by being uniformly empty.
  it('gives a browsing guest link routing, popups and anti-detection', () => {
    const guest = createGuest(300, 'https://example.com/')

    browserManager.attachGuestPolicies(guest as never)

    expect(listenerCount(guest, 'dom-ready')).toBe(1)
    expect(listenerCount(guest, 'frame-created')).toBe(1)
    expect(listenerCount(guest, 'did-create-window')).toBe(1)
    expect(guest.debugger.sendCommand).toHaveBeenCalled()
    expect(navigateTo(guest, 'https://elsewhere.example/')).toBe(false)
  })

  it('gives a workspace-document guest none of it', () => {
    const { guest } = attachPreviewGuest()

    expect(listenerCount(guest, 'dom-ready')).toBe(0)
    expect(listenerCount(guest, 'frame-created')).toBe(0)
    expect(listenerCount(guest, 'did-create-window')).toBe(0)
    expect(guest.debugger.sendCommand).not.toHaveBeenCalled()
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('holds a workspace-document guest inside the grant it is showing', () => {
    const { guest, grantId } = attachPreviewGuest()

    expect(navigateTo(guest, buildDocPreviewUrl(grantId, 'other.html'))).toBe(false)
    expect(navigateTo(guest, 'https://example.com/')).toBe(true)
    expect(guest.webRtcPolicy).toBe('disable_non_proxied_udp')
  })

  it('denies every window a workspace-document guest asks for', () => {
    const { guest } = attachPreviewGuest()

    expect(guest.windowOpenHandler?.({ url: 'https://example.com/', frameName: '' })).toEqual({
      action: 'deny'
    })
  })

  // Why teardown and not just install: registration and teardown both key on the guest having been
  // policy-attached, so a profile that installs outside that bookkeeping leaves the id marked
  // attached forever and stays answerable to tools after the surface is gone.
  it('tears a workspace-document guest down through the same policy cleanup', () => {
    const { guest, browserPageId } = attachPreviewGuest(302)
    expect(getWorkspaceDocPageGuest(browserPageId, host.id)).toBe(guest as never)

    for (const listener of guest.listeners.get('destroyed') ?? []) {
      listener()
    }

    expect(getWorkspaceDocPageGuest(browserPageId, host.id)).toBeNull()
    // The manager's own bookkeeping was reached too: a second attach is refused while the id is
    // still marked policy-attached, and accepted once its teardown has run.
    browserManager.attachGuestPolicies(guest as never)
    expect(listenerCount(guest, 'dom-ready')).toBe(1)
  })

  // The seam the whole split rests on: one public door answers for both halves, and each page id
  // resolves in exactly one of them. Asserted against the real manager, because the IPC census
  // test has to mock it.
  describe('the one door across both halves of the registry', () => {
    const BROWSING_PAGE_ID = 'browser-page-1'

    function registerBrowsingGuest(id = 400): GuestFake {
      const guest = createGuest(id, 'https://example.com/')
      browserMocks.webContentsFromIdMock.mockReturnValue(guest)
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: BROWSING_PAGE_ID,
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        webContentsId: id,
        rendererWebContentsId: host.id
      })
      return guest
    }

    it('answers each page with the guest of its own half', () => {
      const browsing = registerBrowsingGuest()
      const { guest: document, browserPageId } = attachPreviewGuest()

      expect(browserManager.getAuthorizedGuest(BROWSING_PAGE_ID, host.id)).toBe(browsing as never)
      expect(browserManager.getAuthorizedGuest(browserPageId, host.id)).toBe(document as never)
    })

    // Why this is the containment claim and not a lookup detail: page management, agent commands,
    // download routing and certificate attribution all read the browsing map directly, so a
    // document page being absent from it is what fences them without a guard of their own.
    it('keeps a document page out of the browsing map entirely', () => {
      registerBrowsingGuest()
      const { browserPageId } = attachPreviewGuest()

      expect(browserManager.getGuestWebContentsId(browserPageId)).toBeNull()
      expect([...browserManager.getWebContentsIdByTabId().keys()]).toEqual([BROWSING_PAGE_ID])
    })
  })

  it('attaches a guest once whatever profile it was asked for', () => {
    const { guest } = attachPreviewGuest(303)

    browserManager.attachGuestPolicies(guest as never)

    expect(listenerCount(guest, 'dom-ready')).toBe(0)
    expect(listenerCount(guest, 'will-navigate')).toBe(1)
  })
})
