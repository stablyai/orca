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
import type { BrowserAnnotationViewportBridgeOptions } from '../../shared/browser-annotation-viewport-bridge'
import {
  rendererWebContentsId,
  resetBrowserManagerMocks,
  resetBrowserManagerState
} from './browser-manager-test-harness'
import {
  createViewportGuestFactory,
  flushViewportOps
} from './browser-manager-viewport-test-fixtures'

const { webContentsFromIdMock } = browserMocks
const makeGuest = createViewportGuestFactory(browserMocks)

const BRIDGE_OPTIONS: BrowserAnnotationViewportBridgeOptions = {
  emitViewport: false,
  enabled: true,
  markers: [],
  token: 'annotationviewporttoken'
}

function registerPage(pageId: string, guest: Record<string, unknown>): void {
  webContentsFromIdMock.mockReturnValue(guest)
  browserManager.attachGuestPolicies(guest as never)
  browserManager.registerGuest({
    browserPageId: pageId,
    webContentsId: guest.id as number,
    rendererWebContentsId
  })
}

/** The production resolver's shape: read the registry now, not when the request was made. */
function resolveFromRegistry(pageId: string): () => Electron.WebContents | null {
  return () => browserManager.getAuthorizedGuest(pageId, rendererWebContentsId)
}

describe('browserManager.setAnnotationViewportBridge', () => {
  beforeEach(() => {
    resetBrowserManagerMocks(browserMocks)
    resetBrowserManagerState()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('installs the bridge in an isolated world', async () => {
    const { guest } = makeGuest(4646)
    registerPage('tab-annotations', guest)

    const ok = await browserManager.setAnnotationViewportBridge(
      'tab-annotations',
      BRIDGE_OPTIONS,
      resolveFromRegistry('tab-annotations')
    )

    expect(ok).toBe(true)
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(
      expect.any(Number),
      [
        expect.objectContaining({
          code: expect.stringContaining('__orcaBrowserAnnotationViewportBridge')
        })
      ],
      false
    )
  })

  // Why this is the case that matters: a cross-process navigation re-registers the same page id
  // with a new WebContents and leaves the retired one alive, so a bridge op that resolved its
  // guest when the request arrived would inject into a page nobody is looking at — and the
  // annotation badges would stop tracking the document on screen.
  it('injects into the guest the page has when a queued op finally runs, not the one it was asked with', async () => {
    const { guest: firstGuest } = makeGuest(5101)
    let releaseFirstInjection = (): void => {}
    // One shared gate for every call, so a wrongly-routed second injection still settles and the
    // test fails on where it landed rather than on a timeout.
    const firstInjectionGate = new Promise<void>((resolve) => {
      releaseFirstInjection = () => resolve()
    })
    firstGuest.executeJavaScriptInIsolatedWorld = vi.fn(() => firstInjectionGate)
    registerPage('tab-swap', firstGuest)

    const firstDone = browserManager.setAnnotationViewportBridge(
      'tab-swap',
      BRIDGE_OPTIONS,
      resolveFromRegistry('tab-swap')
    )
    await flushViewportOps()

    // A second request arrives while the first still holds the chain — at this moment the page is
    // still on the first guest, which is the guest a request-time resolution would capture.
    const secondDone = browserManager.setAnnotationViewportBridge(
      'tab-swap',
      BRIDGE_OPTIONS,
      resolveFromRegistry('tab-swap')
    )
    await flushViewportOps()

    // Only now does the page swap renderer processes, while the second op is still queued.
    const { guest: secondGuest } = makeGuest(5102)
    registerPage('tab-swap', secondGuest)

    releaseFirstInjection()
    await expect(firstDone).resolves.toBe(true)
    await expect(secondDone).resolves.toBe(true)

    expect(secondGuest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
    expect(firstGuest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
  })

  // Why this is the resolver's cleanup and not the bridge's: the authority that reads the registry
  // is the one that can see the guest is gone. The bridge only reports the refusal.
  it('refuses when its guest died while the op was queued, and the resolver drops the registration', async () => {
    const { guest } = makeGuest(5103)
    registerPage('tab-dies', guest)
    expect(browserManager.getGuestWebContentsId('tab-dies')).toBe(5103)

    webContentsFromIdMock.mockReturnValue(null)
    await expect(
      browserManager.setAnnotationViewportBridge(
        'tab-dies',
        BRIDGE_OPTIONS,
        resolveFromRegistry('tab-dies')
      )
    ).resolves.toBe(false)

    // Why assert the registry and not just the answer: a stale guest has to clear every per-tab
    // entry, or the page keeps a dead WebContents id that later ops resolve against.
    expect(browserManager.getGuestWebContentsId('tab-dies')).toBeNull()
  })

  // Why this one exists: an unresolved guest is not the same as a dead one. A request addressed by
  // the wrong renderer names a page that is alive and on screen, and answering it with teardown
  // would cancel that page's in-flight downloads and grabs over a misaddressed message.
  it('refuses a request from the wrong renderer without tearing down the healthy page it named', async () => {
    const { guest } = makeGuest(5105)
    registerPage('tab-mismatch', guest)
    const unregisterGuest = vi.spyOn(browserManager, 'unregisterGuest')

    await expect(
      browserManager.setAnnotationViewportBridge('tab-mismatch', BRIDGE_OPTIONS, () =>
        browserManager.getAuthorizedGuest('tab-mismatch', rendererWebContentsId + 1)
      )
    ).resolves.toBe(false)

    expect(unregisterGuest).not.toHaveBeenCalled()
    expect(browserManager.getGuestWebContentsId('tab-mismatch')).toBe(5105)
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('refuses a destroyed guest without injecting into it', async () => {
    const { guest } = makeGuest(5104)
    registerPage('tab-destroyed', guest)
    ;(guest.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(true)

    await expect(
      browserManager.setAnnotationViewportBridge(
        'tab-destroyed',
        BRIDGE_OPTIONS,
        () => guest as never
      )
    ).resolves.toBe(false)
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  // Why: a document page owns no browsing state, so treating its refusal as a stale page would run
  // teardown against an id the browsing registry never held.
  it('does not run page teardown when a document page resolves to nothing', async () => {
    const unregisterGuest = vi.spyOn(browserManager, 'unregisterGuest')

    await expect(
      browserManager.setAnnotationViewportBridge('doc-page-1', BRIDGE_OPTIONS, () => null)
    ).resolves.toBe(false)

    expect(unregisterGuest).not.toHaveBeenCalled()
  })
})
