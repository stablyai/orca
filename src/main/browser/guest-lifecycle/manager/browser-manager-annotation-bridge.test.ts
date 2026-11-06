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

vi.mock('../popups/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: browserMocks.openPopupWithOriginBarMock
}))

import { browserManager } from '../../browser-manager'
import type { BrowserAnnotationViewportBridgeOptions } from '../../../../shared/browser-annotation-viewport-bridge'
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

const MARKER_OPTIONS: BrowserAnnotationViewportBridgeOptions = {
  ...BRIDGE_OPTIONS,
  markers: [
    {
      id: 'historical-document-marker',
      index: 2,
      isFixed: false,
      rectPage: { x: 80, y: 120, width: 100, height: 40 },
      rectViewport: { x: 80, y: 120, width: 100, height: 40 }
    }
  ]
}

function deferGuestInjection(guest: Record<string, unknown>): () => void {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  guest.executeJavaScriptInIsolatedWorld = vi.fn(() => gate)
  return release
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

  // Navigation can replace the registered guest while its old WebContents remains alive.
  it('injects into the guest the page has when a queued op finally runs, not the one it was asked with', async () => {
    const { guest: firstGuest } = makeGuest(5101)
    let releaseFirstInjection = (): void => {}
    // Share the gate so misrouted injections settle and fail on the target, not a timeout.
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

    const secondDone = browserManager.setAnnotationViewportBridge(
      'tab-swap',
      BRIDGE_OPTIONS,
      resolveFromRegistry('tab-swap')
    )
    await flushViewportOps()

    const { guest: secondGuest } = makeGuest(5102)
    registerPage('tab-swap', secondGuest)

    releaseFirstInjection()
    await expect(firstDone).resolves.toBe(true)
    await expect(secondDone).resolves.toBe(true)

    expect(secondGuest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
    expect(firstGuest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
  })

  it('keeps an in-flight injection and applies the latest fresh markers and token', async () => {
    const { guest } = makeGuest(5203)
    const release = deferGuestInjection(guest)
    const resolveGuest = resolveFromRegistry('tab-fresh-markers')
    registerPage('tab-fresh-markers', guest)
    const inFlight = browserManager.setAnnotationViewportBridge(
      'tab-fresh-markers',
      MARKER_OPTIONS,
      resolveGuest
    )
    await flushViewportOps()
    const cleared = browserManager.setAnnotationViewportBridge(
      'tab-fresh-markers',
      { ...BRIDGE_OPTIONS, enabled: false },
      resolveGuest
    )
    const fresh = browserManager.setAnnotationViewportBridge(
      'tab-fresh-markers',
      {
        ...MARKER_OPTIONS,
        token: 'remintedpreviewtoken',
        markers: MARKER_OPTIONS.markers.map((marker) => ({ ...marker, id: 'fresh-preview-marker' }))
      },
      resolveGuest
    )

    release()
    await expect(inFlight).resolves.toBe(true)
    await expect(cleared).resolves.toBe(false)
    await expect(fresh).resolves.toBe(true)
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2)
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenLastCalledWith(
      expect.any(Number),
      [
        expect.objectContaining({
          code: expect.stringContaining('fresh-preview-marker')
        })
      ],
      false
    )
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenLastCalledWith(
      expect.any(Number),
      [expect.objectContaining({ code: expect.stringContaining('remintedpreviewtoken') })],
      false
    )
  })

  it('does not run a queued marker request after page teardown removes its chain', async () => {
    const { guest } = makeGuest(5205)
    const release = deferGuestInjection(guest)
    registerPage('tab-closed-queue', guest)
    const resolveGuest = resolveFromRegistry('tab-closed-queue')
    const inFlight = browserManager.setAnnotationViewportBridge(
      'tab-closed-queue',
      BRIDGE_OPTIONS,
      resolveGuest
    )
    await flushViewportOps()
    const retired = browserManager.setAnnotationViewportBridge(
      'tab-closed-queue',
      MARKER_OPTIONS,
      resolveGuest
    )
    browserManager.unregisterGuest('tab-closed-queue')

    release()
    await expect(inFlight).resolves.toBe(true)
    await expect(retired).resolves.toBe(false)
    expect(guest.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
    expect(browserManager.getGuestWebContentsId('tab-closed-queue')).toBeNull()
  })

  // The registry resolver owns stale-guest cleanup; the bridge only reports refusal.

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
})
