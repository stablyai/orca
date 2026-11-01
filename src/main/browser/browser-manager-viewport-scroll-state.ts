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
  protected readonly rendererWebContentsIdByTabId = new Map<string, number>()
  // Panning follows requested metrics; identity follows applied metrics, both fenced to one guest.
  protected readonly viewportPresetByTabId = new Map<string, ViewportPresetState>()
  protected readonly viewportScrollStateByTabId = new Map<string, BrowserViewportScrollState>()

  protected isViewportPresetActive(browserTabId: string, guestWebContentsId: number): boolean {
    const state = this.viewportPresetByTabId.get(browserTabId)
    return state?.guestWebContentsId === guestWebContentsId && state.requested !== null
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
    this.viewportScrollStateByTabId.set(browserTabId, state)
  }

  recordViewportScrollDelta(browserTabId: string, deltaX: number, deltaY: number): void {
    const state = this.viewportScrollStateByTabId.get(browserTabId)
    if (!state) {
      return
    }
    this.viewportScrollStateByTabId.set(browserTabId, {
      ...state,
      scrollLeft: Math.min(state.maxScrollLeft, Math.max(0, state.scrollLeft + deltaX)),
      scrollTop: Math.min(state.maxScrollTop, Math.max(0, state.scrollTop + deltaY))
    })
  }

  protected canViewportScroll(browserTabId: string, mouse: Electron.MouseWheelInputEvent): boolean {
    const state = this.viewportScrollStateByTabId.get(browserTabId)
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
    const preset = this.viewportPresetByTabId.get(browserTabId)
    if (preset?.guestWebContentsId === guestWebContentsId) {
      this.viewportPresetByTabId.set(browserTabId, { ...preset, applied })
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
