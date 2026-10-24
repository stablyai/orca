import { webContents } from 'electron'
import type {
  BrowserViewportOverride,
  BrowserViewportScrollState
} from '../../shared/browser-workspace-types'

type ViewportPresetState = {
  guestWebContentsId: number
  requested: BrowserViewportOverride | null
  /** Metrics Chromium accepted for this guest, independent of the requested preset. */
  applied: BrowserViewportOverride | null
}

export abstract class BrowserManagerViewportScrollState {
  protected readonly webContentsIdByTabId = new Map<string, number>()
  protected readonly tabIdByWebContentsId = new Map<number, string>()
  protected readonly rendererWebContentsIdByTabId = new Map<string, number>()
  // Panning follows requested metrics; identity follows applied metrics, both fenced to one guest.
  protected readonly viewportPresetsByGuestId = new Map<number, ViewportPresetState>()
  protected readonly viewportScrollStatesByGuestId = new Map<number, BrowserViewportScrollState>()

  protected isViewportPresetActive(browserTabId: string, guestWebContentsId: number): boolean {
    const state = this.viewportPresetsByGuestId.get(guestWebContentsId)
    return this.isRegisteredPageGuest(browserTabId, guestWebContentsId) && state?.requested != null
  }

  protected isRegisteredPageGuest(browserTabId: string, guestId: number): boolean {
    return this.tabIdByWebContentsId.get(guestId) === browserTabId
  }

  setViewportScrollState(
    browserTabId: string,
    rendererWebContentsId: number,
    state: BrowserViewportScrollState
  ): void {
    if (this.rendererWebContentsIdByTabId.get(browserTabId) !== rendererWebContentsId) {
      return
    }
    if (
      ![state.scrollLeft, state.scrollTop, state.maxScrollLeft, state.maxScrollTop].every(
        (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
      )
    ) {
      return
    }
    const guestId = this.webContentsIdByTabId.get(browserTabId)
    if (guestId !== undefined) {
      this.viewportScrollStatesByGuestId.set(guestId, state)
    }
  }

  recordViewportScrollDelta(guestId: number, deltaX: number, deltaY: number): void {
    const state = this.viewportScrollStatesByGuestId.get(guestId)
    if (!state) {
      return
    }
    this.viewportScrollStatesByGuestId.set(guestId, {
      ...state,
      scrollLeft: Math.min(state.maxScrollLeft, Math.max(0, state.scrollLeft + deltaX)),
      scrollTop: Math.min(state.maxScrollTop, Math.max(0, state.scrollTop + deltaY))
    })
  }

  protected canViewportScroll(guestId: number, mouse: Electron.MouseWheelInputEvent): boolean {
    const state = this.viewportScrollStatesByGuestId.get(guestId)
    if (!state) {
      return false
    }
    const deltaX = typeof mouse.deltaX === 'number' ? mouse.deltaX : 0
    const deltaY = typeof mouse.deltaY === 'number' ? mouse.deltaY : 0
    const canScrollAxis = (delta: number, position: number, maximum: number): boolean => {
      if (delta < 0) {
        return position > 0
      }
      if (delta > 0) {
        return position < maximum
      }
      return false
    }
    return (
      canScrollAxis(deltaX, state.scrollLeft, state.maxScrollLeft) ||
      canScrollAxis(deltaY, state.scrollTop, state.maxScrollTop)
    )
  }

  protected recordAppliedViewportOverride(
    browserTabId: string,
    guestWebContentsId: number,
    applied: BrowserViewportOverride | null
  ): void {
    const preset = this.viewportPresetsByGuestId.get(guestWebContentsId)
    if (preset && this.isRegisteredPageGuest(browserTabId, guestWebContentsId)) {
      this.viewportPresetsByGuestId.set(guestWebContentsId, { ...preset, applied })
    }
  }

  protected resolveRendererForBrowserTab(browserTabId: string): Electron.WebContents | null {
    const rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (!rendererWebContentsId) {
      return null
    }
    const renderer = webContents.fromId(rendererWebContentsId)
    if (!renderer || renderer.isDestroyed()) {
      return null
    }
    return renderer
  }
}
