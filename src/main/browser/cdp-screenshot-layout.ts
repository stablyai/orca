export type CdpLayoutMetrics = {
  cssContentSize?: { width?: number; height?: number }
  contentSize?: { width?: number; height?: number }
  cssVisualViewport?: { zoom?: number }
}

export function getLayoutClip(metrics: CdpLayoutMetrics): {
  x: number
  y: number
  width: number
  height: number
  scale: number
} | null {
  const cssContentSize = metrics.cssContentSize
  const size = cssContentSize ?? metrics.contentSize
  const width = size?.width
  const height = size?.height
  if (
    typeof width !== 'number' ||
    !Number.isFinite(width) ||
    width <= 0 ||
    typeof height !== 'number' ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    return null
  }

  let zoom = 1
  if (cssContentSize && metrics.cssVisualViewport?.zoom !== undefined) {
    zoom = metrics.cssVisualViewport.zoom
    if (!Number.isFinite(zoom) || zoom <= 0) {
      return null
    }
  }

  const clipWidth = Math.ceil(width * zoom)
  const clipHeight = Math.ceil(height * zoom)
  if (
    !Number.isSafeInteger(clipWidth) ||
    clipWidth <= 0 ||
    !Number.isSafeInteger(clipHeight) ||
    clipHeight <= 0
  ) {
    return null
  }

  // Page.Viewport is DIP while cssContentSize is CSS pixels; page zoom bridges them.
  return { x: 0, y: 0, width: clipWidth, height: clipHeight, scale: 1 }
}
