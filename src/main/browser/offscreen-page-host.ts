import { BrowserWindow, webContents as electronWebContents } from 'electron'
import type { OffscreenSharedTexture, WebContents, WebPreferences } from 'electron'
import type {
  OffscreenPageCaret,
  OffscreenPageCommand,
  OffscreenPageFileDrop,
  OffscreenPageGuestEvent,
  OffscreenPageUserInput,
  OffscreenPageViewport
} from '../../shared/offscreen-page-protocol'
import {
  attachBrowserPageGuestPolicies,
  hardenBrowserPageGuestPreferences
} from './browser-page-guest-admission'
import { browserManager } from './browser-manager'
import {
  forwardOffscreenPageGuestEvents,
  OFFSCREEN_PAGE_EVENT_CHANNEL
} from './offscreen-page-guest-events'
import {
  createOffscreenPageFrameForwarder,
  type OffscreenPageFrameForwarder
} from './offscreen-page-frame-forwarder'
import { dispatchOffscreenPageUserInput } from './offscreen-page-user-input'
import { readOffscreenPageCaret } from './offscreen-page-caret'
import { runOffscreenPageCommand } from './offscreen-page-commands'
import { sendOffscreenPageFrame } from './offscreen-page-frame-delivery'
import { syncOffscreenPageHostZoom, type OffscreenPageHostZoom } from './offscreen-page-host-zoom'
import { createOffscreenPageFeatures, type OffscreenPageFeatures } from './offscreen-page-features'
import {
  mayOpenOffscreenPageSelect,
  readOpenOffscreenPageSelect,
  showOffscreenPageSelectMenu,
  toHostSelectAnchor,
  type OffscreenPageSelectPopup
} from './offscreen-page-select-popup'
import { createOffscreenPageOverlays, type OffscreenPageOverlays } from './offscreen-page-overlays'
import { createOffscreenPageSurface, type OffscreenPageSurface } from './offscreen-page-surface'

export const OFFSCREEN_PAGE_FRAME_CHANNEL = 'offscreen-page:frame'
export const OFFSCREEN_PAGE_SELECT_CHANNEL = 'offscreen-page:select'

type HostedPage = {
  surface: OffscreenPageSurface
  rendererWebContentsId: number
  forwarder: OffscreenPageFrameForwarder<OffscreenSharedTexture>
  stopForwardingEvents: () => void
  features: OffscreenPageFeatures
  hostZoom: OffscreenPageHostZoom | null
  /** An open select waiting for the renderer to say where its menu goes. */
  openSelect: OffscreenPageSelectPopup | null
  overlays: OffscreenPageOverlays
}

export type OffscreenPageCreateParams = {
  browserPageId: string
  partition: string
  rendererWebContentsId: number
  viewport: OffscreenPageViewport
  /** Already admitted by isAdmissibleBrowserPageGuest; loaded after policies are attached. */
  src: string
  guestPreloadPath: string
}

/**
 * Owns desktop browser pages rendered offscreen and painted into the renderer as GPU textures.
 * A page here is its own top-level WebContents with no native view, so neither agent CDP input
 * nor Chromium's mouse-down focus handoff can reach the host window's focus or IME.
 */
export class OffscreenPageHost {
  private readonly pages = new Map<string, HostedPage>()

  create(params: OffscreenPageCreateParams): WebContents {
    if (this.pages.has(params.browserPageId)) {
      throw new Error(`Offscreen page ${params.browserPageId} already exists`)
    }
    const webPreferences: WebPreferences = {}
    hardenBrowserPageGuestPreferences(webPreferences, params.partition, params.guestPreloadPath)
    // Why: the preload reports tooltips and datalists from every frame. It stays sandboxed and
    // isolated; this only runs it in subframes too.
    webPreferences.nodeIntegrationInSubFrames = true
    const surface = createOffscreenPageSurface({
      width: params.viewport.width,
      height: params.viewport.height,
      webPreferences
    })
    const { contents } = surface
    const page: HostedPage = {
      surface,
      rendererWebContentsId: params.rendererWebContentsId,
      hostZoom: null,
      features: createOffscreenPageFeatures({
        contents,
        webPreferences,
        parentWindow: () => {
          const renderer = this.rendererFor(page)
          return renderer ? BrowserWindow.fromWebContents(renderer) : null
        }
      }),
      openSelect: null,
      overlays: createOffscreenPageOverlays({
        surface,
        send: (channel, payload) =>
          this.rendererFor(page)?.send(channel, params.browserPageId, payload),
        hostZoomFactor: () => page.hostZoom?.factor ?? 1
      }),
      stopForwardingEvents: forwardOffscreenPageGuestEvents(contents, (event) => {
        this.rendererFor(page)?.send(OFFSCREEN_PAGE_EVENT_CHANNEL, params.browserPageId, event)
      }),
      forwarder: createOffscreenPageFrameForwarder(
        {
          deliver: (texture) =>
            sendOffscreenPageFrame(
              this.pages.get(params.browserPageId) === page ? this.rendererFor(page) : null,
              texture,
              params.browserPageId
            )
        },
        (error) => console.warn('[offscreen-page] frame delivery failed:', String(error))
      )
    }
    this.pages.set(params.browserPageId, page)
    // Why admit first: policies and route guards read the owner record while attaching.
    browserManager.admitRendererOffscreenGuest(contents.id, params.rendererWebContentsId)
    attachBrowserPageGuestPolicies(contents)
    contents.on('paint', (event, dirty, image) => {
      if (!event.texture) {
        page.overlays.onBitmapPaint(dirty, image)
        return
      }
      // Why drop popups: Electron gives no position for them; selects are drawn by showSelectMenu.
      if (event.texture.textureInfo.widgetType === 'popup') {
        event.texture.release()
        return
      }
      page.forwarder.onPaint(event.texture)
    })
    contents.once('destroyed', () => {
      // Only an unrequested death reaches here; close() unmaps the page first.
      if (this.pages.get(params.browserPageId) === page) {
        this.pages.delete(params.browserPageId)
        disposeHostedPage(page)
        const event: OffscreenPageGuestEvent = { type: 'destroyed', detail: {} }
        this.rendererFor(page)?.send(OFFSCREEN_PAGE_EVENT_CHANNEL, params.browserPageId, event)
      }
    })
    this.setViewport(params.browserPageId, params.viewport)
    // Why after policies: popup and navigation guards must see the very first navigation.
    void contents.loadURL(params.src).catch(() => {
      // Load failures reach the renderer as did-fail-load.
    })
    return contents
  }

  setViewport(browserPageId: string, viewport: OffscreenPageViewport): void {
    const page = this.livePage(browserPageId)
    if (!page) {
      return
    }
    page.hostZoom = syncOffscreenPageHostZoom({
      browserPageId,
      contents: page.surface.contents,
      renderer: this.rendererFor(page),
      current: page.hostZoom
    })
    const factor = page.hostZoom?.factor ?? 1
    const width = Math.max(1, Math.round(viewport.width * factor))
    const height = Math.max(1, Math.round(viewport.height * factor))
    page.surface.setSize(width, height)
    page.features.frameRate.setVisible(viewport.visible)
  }

  dropFiles(browserPageId: string, drop: OffscreenPageFileDrop): void {
    const page = this.livePage(browserPageId)
    if (page) {
      const factor = page.hostZoom?.factor ?? 1
      void page.features.drag.dropFiles({ ...drop, x: drop.x * factor, y: drop.y * factor })
    }
  }

  async dispatchUserInput(browserPageId: string, input: OffscreenPageUserInput): Promise<void> {
    const page = this.livePage(browserPageId)
    if (page) {
      const factor = page.hostZoom?.factor ?? 1
      const scaled =
        input.kind === 'mouse' || input.kind === 'wheel'
          ? { ...input, x: input.x * factor, y: input.y * factor }
          : input
      if (input.kind === 'key' && this.isGrabKey(browserPageId, page, input)) {
        return
      }
      if (page.overlays.routeInput(scaled)) {
        return
      }
      if (
        scaled.kind === 'wheel' &&
        browserManager.handleOffscreenPageViewportWheel(browserPageId, page.surface.contents, {
          type: 'mouseWheel',
          x: Math.round(scaled.x),
          y: Math.round(scaled.y),
          deltaX: scaled.deltaX,
          deltaY: scaled.deltaY,
          modifiers: scaled.modifiers
        })
      ) {
        return
      }
      await dispatchOffscreenPageUserInput(page.surface.contents, page.features, scaled)
      if (mayOpenOffscreenPageSelect(input)) {
        const renderer = this.rendererFor(page)
        page.openSelect = await readOpenOffscreenPageSelect(page.surface.contents)
        if (page.openSelect && renderer) {
          const anchor = toHostSelectAnchor(page.openSelect, page.surface.contents, page.hostZoom)
          renderer.send(OFFSCREEN_PAGE_SELECT_CHANNEL, browserPageId, anchor)
        }
      }
    }
  }

  private isGrabKey(
    browserPageId: string,
    page: HostedPage,
    input: Extract<OffscreenPageUserInput, { kind: 'key' }>
  ): boolean {
    return browserManager.handleOffscreenPageGrabKey(browserPageId, page.surface.contents, {
      type: input.type,
      key: input.key,
      code: input.code,
      meta: input.modifiers.includes('meta'),
      control: input.modifiers.includes('control'),
      alt: input.modifiers.includes('alt'),
      shift: input.modifiers.includes('shift'),
      isAutoRepeat: input.repeat
    })
  }

  /** Shows the menu for the select offered by offerOpenSelect; `point` is window-client CSS px. */
  showSelectMenu(browserPageId: string, point: { x: number; y: number }): void {
    const page = this.livePage(browserPageId)
    const renderer = page && this.rendererFor(page)
    const window = renderer && BrowserWindow.fromWebContents(renderer)
    const popup = page?.openSelect
    if (!page || !window || !popup) {
      return
    }
    page.openSelect = null
    const hostFactor = renderer.getZoomFactor()
    showOffscreenPageSelectMenu({
      contents: page.surface.contents,
      window,
      popup,
      point: { x: point.x * hostFactor, y: point.y * hostFactor },
      pageZoomFactor: page.surface.contents.getZoomFactor()
    })
  }

  runCommand(browserPageId: string, command: OffscreenPageCommand): void {
    const contents = this.livePage(browserPageId)?.surface.contents
    if (contents) {
      runOffscreenPageCommand(contents, command)
    }
  }

  async readCaret(browserPageId: string): Promise<OffscreenPageCaret | null> {
    const page = this.livePage(browserPageId)
    return page ? readOffscreenPageCaret(page.surface.contents, page.hostZoom?.factor ?? 1) : null
  }

  setKeyboardFocus(browserPageId: string, focused: boolean): void {
    this.livePage(browserPageId)?.features.setKeyboardFocus(focused)
  }

  /** Gives the page keyboard focus inside its own WebContents; there is no native view to activate. */
  focusPage(browserPageId: string): void {
    this.livePage(browserPageId)?.surface.contents.focus()
  }

  /** Whether `webContentsId` is a live page shown by that renderer; the host's own record. */
  ownsWebContents(webContentsId: number, rendererWebContentsId: number): boolean {
    for (const page of this.pages.values()) {
      if (page.surface.contents.id === webContentsId && !page.surface.isDestroyed()) {
        return page.rendererWebContentsId === rendererWebContentsId
      }
    }
    return false
  }

  hostsWebContents(webContentsId: number): boolean {
    return [...this.pages.values()].some((page) => page.surface.contents.id === webContentsId)
  }

  isOwnedBy(browserPageId: string, rendererWebContentsId: number): boolean {
    return this.livePage(browserPageId)?.rendererWebContentsId === rendererWebContentsId
  }

  closeOwnedBy(rendererWebContentsId: number): void {
    for (const [browserPageId, page] of this.pages) {
      if (page.rendererWebContentsId === rendererWebContentsId) {
        this.close(browserPageId)
      }
    }
  }

  getWebContents(browserPageId: string): WebContents | null {
    return this.livePage(browserPageId)?.surface.contents ?? null
  }

  close(browserPageId: string): void {
    const page = this.pages.get(browserPageId)
    this.pages.delete(browserPageId)
    if (page) {
      disposeHostedPage(page)
      page.surface.destroy()
    }
  }

  closeAll(): void {
    for (const browserPageId of this.pages.keys()) {
      this.close(browserPageId)
    }
  }

  private livePage(browserPageId: string): HostedPage | null {
    const page = this.pages.get(browserPageId)
    return page && !page.surface.isDestroyed() ? page : null
  }

  private rendererFor(page: HostedPage): WebContents | null {
    const renderer = electronWebContents.fromId(page.rendererWebContentsId)
    return renderer && !renderer.isDestroyed() ? renderer : null
  }
}

function disposeHostedPage(page: HostedPage): void {
  page.forwarder.dispose()
  page.stopForwardingEvents()
  page.features.dispose()
}
