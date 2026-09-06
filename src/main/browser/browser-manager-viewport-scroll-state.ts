import { webContents } from 'electron'
import type { BrowserViewportScrollState } from '../../shared/browser-workspace-types'

/**
 * Renderer routing plus the host-side viewport-preset geometry the wheel path needs to decide
 * whether a scroll belongs to the emulated viewport or to the guest page.
 */
export abstract class BrowserManagerViewportScrollState {
  protected readonly rendererWebContentsIdByTabId = new Map<string, number>()
  // Why: host-side wheel panning follows the requested local viewport on the owning guest;
  // replacement guests must not inherit a retired guest's state.
  protected readonly viewportPresetActiveByTabId = new Map<
    string,
    { guestWebContentsId: number; active: boolean }
  >()
  protected readonly viewportScrollStateByTabId = new Map<string, BrowserViewportScrollState>()

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
