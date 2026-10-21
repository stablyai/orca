import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'

export type BrowserTouchLayout = {
  width: number
  height: number
}

export type BrowserPoint = {
  x: number
  y: number
}

export type BrowserFrameGeometry = {
  sourceWidth: number
  sourceHeight: number
  viewportWidth: number
  viewportHeight: number
  renderedWidth: number
  renderedHeight: number
  offsetX: number
  offsetY: number
  scale: number
  /**
   * What the frame's device pixels divide by to reach the page's own CSS pixels.
   *
   * Mobile view emulates a phone viewport, and a page with no `<meta name="viewport">` lays out at
   * Chromium's 980 px default and is scaled into it, so the two spaces differ by this much. The
   * browser's input commands take page CSS pixels, which is why nothing may be sent in the frame's
   * space. One in web view mode, where no emulation is on.
   */
  pageScale: number
}

export type BrowserZoomState = {
  scale: number
  offsetX: number
  offsetY: number
}

export function computeBrowserFrameGeometry(
  layout: BrowserTouchLayout | null,
  metadata: BrowserScreencastFrameMetadata | null
): BrowserFrameGeometry | null {
  if (!layout || layout.width <= 0 || layout.height <= 0) {
    return null
  }
  const sourceWidth = getPositiveFiniteNumber(metadata?.deviceWidth) ?? layout.width
  const sourceHeight = getPositiveFiniteNumber(metadata?.deviceHeight) ?? layout.height
  const scale = Math.min(layout.width / sourceWidth, layout.height / sourceHeight)
  if (!Number.isFinite(scale) || scale <= 0) {
    return null
  }
  const renderedWidth = sourceWidth * scale
  const renderedHeight = sourceHeight * scale
  return {
    pageScale: getPositiveFiniteNumber(metadata?.pageScaleFactor) ?? 1,
    sourceWidth,
    sourceHeight,
    viewportWidth: layout.width,
    viewportHeight: layout.height,
    renderedWidth,
    renderedHeight,
    offsetX: (layout.width - renderedWidth) / 2,
    offsetY: (layout.height - renderedHeight) / 2,
    scale
  }
}

export function mapScreenToBrowserPoint(
  x: number,
  y: number,
  layout: BrowserTouchLayout | null,
  metadata: BrowserScreencastFrameMetadata | null,
  zoom: BrowserZoomState
): BrowserPoint | null {
  const geometry = computeBrowserFrameGeometry(layout, metadata)
  if (!geometry || zoom.scale <= 0) {
    return null
  }
  const frameCenterX = geometry.offsetX + geometry.renderedWidth / 2 + zoom.offsetX
  const frameCenterY = geometry.offsetY + geometry.renderedHeight / 2 + zoom.offsetY
  const localX = (x - frameCenterX) / zoom.scale + geometry.renderedWidth / 2
  const localY = (y - frameCenterY) / zoom.scale + geometry.renderedHeight / 2
  if (
    localX < 0 ||
    localY < 0 ||
    localX > geometry.renderedWidth ||
    localY > geometry.renderedHeight
  ) {
    return null
  }
  // Why no scrollOffsetX/Y: the frame is the visual viewport and the input commands take
  // viewport-relative CSS pixels, so adding the page's scroll would aim a screenful past the target.
  return {
    x: clamp(
      Math.round(((localX / geometry.renderedWidth) * geometry.sourceWidth) / geometry.pageScale),
      0,
      geometry.sourceWidth / geometry.pageScale
    ),
    y: clamp(
      Math.round(((localY / geometry.renderedHeight) * geometry.sourceHeight) / geometry.pageScale),
      0,
      geometry.sourceHeight / geometry.pageScale
    )
  }
}

/** A scroll the page should receive, in its own CSS pixels, the way a wheel reports one. */
export type BrowserWheelDelta = { dx: number; dy: number }

/**
 * What one point of screen is worth in the page's own CSS pixels, or null when it cannot be read.
 *
 * Three factors, and every screen-space quantity the pane sends needs all three: the frame's fit
 * into the pane, the pinch zoom on top of it, and the page scale the frame was painted at. A
 * consumer that composes two of them is off by the third, which is how the wheel came to deliver
 * 41% of the requested scroll on a page with no viewport meta.
 */
export function browserScreenToPageCssScale(
  geometry: BrowserFrameGeometry | null,
  zoomScale: number
): number | null {
  const scale = geometry === null ? zoomScale : geometry.scale * zoomScale * geometry.pageScale
  return Number.isFinite(scale) && scale > 0 ? scale : null
}

/** A screen-space gesture delta as the page's own CSS pixels, inverted the way a wheel reports it. */
export function browserWheelDeltaFromScreen(
  screenDx: number,
  screenDy: number,
  geometry: BrowserFrameGeometry | null,
  zoomScale: number
): BrowserWheelDelta {
  const scale = browserScreenToPageCssScale(geometry, zoomScale) ?? 1
  return { dx: roundedWheelDelta(-screenDx / scale), dy: roundedWheelDelta(-screenDy / scale) }
}

/** `Math.round` answers -0 for an axis that moved nothing; the wheel carries a plain zero. */
function roundedWheelDelta(value: number): number {
  const rounded = Math.round(value)
  return rounded === 0 ? 0 : rounded
}

export function computeBrowserTouchClickRadiusCss(
  layout: BrowserTouchLayout | null,
  metadata: BrowserScreencastFrameMetadata | null,
  zoom: BrowserZoomState,
  touchRadiusDip: number
): number {
  const geometry = computeBrowserFrameGeometry(layout, metadata)
  const scale = browserScreenToPageCssScale(geometry, zoom.scale)
  if (scale === null) {
    return 10
  }
  // Why: phone taps are finger-sized while CDP clicks are pixel exact. Convert a
  // small screen radius back into page CSS pixels so tiny links remain hittable.
  return clamp(Math.round(touchRadiusDip / scale), 6, 48)
}

export function clampBrowserZoomState(
  next: BrowserZoomState,
  geometry: BrowserFrameGeometry,
  minZoom: number,
  maxZoom: number
): BrowserZoomState {
  const scale = clamp(next.scale, minZoom, maxZoom)
  if (scale <= minZoom + 0.01) {
    return { scale: minZoom, offsetX: 0, offsetY: 0 }
  }
  const maxOffsetX = Math.max(0, (geometry.renderedWidth * scale - geometry.viewportWidth) / 2)
  const maxOffsetY = Math.max(0, (geometry.renderedHeight * scale - geometry.viewportHeight) / 2)
  return {
    scale,
    offsetX: clamp(next.offsetX, -maxOffsetX, maxOffsetX),
    offsetY: clamp(next.offsetY, -maxOffsetY, maxOffsetY)
  }
}

export function readLocalTouchPoint(touch: unknown): BrowserPoint | null {
  if (!touch || typeof touch !== 'object') {
    return null
  }
  const eventTouch = touch as {
    locationX?: unknown
    locationY?: unknown
  }
  if (
    typeof eventTouch.locationX !== 'number' ||
    !Number.isFinite(eventTouch.locationX) ||
    typeof eventTouch.locationY !== 'number' ||
    !Number.isFinite(eventTouch.locationY)
  ) {
    return null
  }
  return { x: eventTouch.locationX, y: eventTouch.locationY }
}

function getPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
