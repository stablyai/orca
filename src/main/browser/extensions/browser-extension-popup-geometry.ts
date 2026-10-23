import type { BrowserExtensionAnchorRect } from '../../../shared/browser-extension-toolbar-types'

type Rect = { x: number; y: number; width: number; height: number }
type Size = { width: number; height: number }

/** Chrome's action popup limits. */
export const BROWSER_EXTENSION_POPUP_MIN: Size = { width: 25, height: 25 }
export const BROWSER_EXTENSION_POPUP_MAX: Size = { width: 800, height: 600 }
const ANCHOR_GAP_PX = 2

export function clampBrowserExtensionPopupSize(size: Size): Size {
  const clamp = (value: number, min: number, max: number): number =>
    Math.round(Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)))
  return {
    width: clamp(size.width, BROWSER_EXTENSION_POPUP_MIN.width, BROWSER_EXTENSION_POPUP_MAX.width),
    height: clamp(
      size.height,
      BROWSER_EXTENSION_POPUP_MIN.height,
      BROWSER_EXTENSION_POPUP_MAX.height
    )
  }
}

/** A renderer CSS-pixel rect in screen coordinates, given the window's content bounds and zoom. */
export function anchorToScreen(
  anchor: BrowserExtensionAnchorRect,
  contentBounds: Rect,
  zoomFactor: number
): Rect {
  return {
    x: Math.round(contentBounds.x + anchor.x * zoomFactor),
    y: Math.round(contentBounds.y + anchor.y * zoomFactor),
    width: Math.round(anchor.width * zoomFactor),
    height: Math.round(anchor.height * zoomFactor)
  }
}

/**
 * Below the button with right edges aligned (Chrome's toolbar bubble), kept inside the work
 * area; flips above the button when there is no room below.
 */
export function placeBrowserExtensionPopup(anchor: Rect, size: Size, workArea: Rect): Rect {
  const workRight = workArea.x + workArea.width
  const workBottom = workArea.y + workArea.height
  const x = Math.max(
    workArea.x,
    Math.min(anchor.x + anchor.width - size.width, workRight - size.width)
  )
  const below = anchor.y + anchor.height + ANCHOR_GAP_PX
  const above = anchor.y - ANCHOR_GAP_PX - size.height
  const y =
    below + size.height <= workBottom || above < workArea.y
      ? Math.max(workArea.y, Math.min(below, workBottom - size.height))
      : above
  return { x, y, width: size.width, height: size.height }
}
