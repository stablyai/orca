import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'
import { browserScreencastPageScale } from '../../../src/shared/browser-screencast-input-scale'

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

/**
 * Maps a point on the streamed frame to the page coordinate to send as browser input.
 *
 * Returns null when the point falls outside the rendered frame. Why page scale divides in:
 * frame dimensions are device-independent pixels while browser input is read as viewport
 * CSS pixels, so below a page scale of 1 the untouched value lands beside the target.
 */
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
  const pageScale = browserScreencastPageScale(metadata)
  // Frame dimensions are device-independent pixels; browser input uses viewport CSS pixels.
  return {
    x: clamp(Math.round(localX / geometry.scale / pageScale), 0, geometry.sourceWidth / pageScale),
    y: clamp(Math.round(localY / geometry.scale / pageScale), 0, geometry.sourceHeight / pageScale)
  }
}

/**
 * Converts a finger-sized touch radius into the page CSS pixels used for link hit testing.
 *
 * Falls back to 10 CSS pixels when frame geometry, client zoom or page scale is unusable.
 */
export function computeBrowserTouchClickRadiusCss(
  layout: BrowserTouchLayout | null,
  metadata: BrowserScreencastFrameMetadata | null,
  zoom: BrowserZoomState,
  touchRadiusDip: number
): number {
  const geometry = computeBrowserFrameGeometry(layout, metadata)
  const scale = (geometry?.scale ?? 1) * zoom.scale * browserScreencastPageScale(metadata)
  if (!Number.isFinite(scale) || scale <= 0) {
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
