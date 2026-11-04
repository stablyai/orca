import { useCallback, useEffect, useState, type RefObject } from 'react'
import { Platform, type View } from 'react-native'

export type PaneLayoutRect = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export type VisualViewportSnapshot = {
  readonly scale: number
  readonly offsetLeft: number
  readonly offsetTop: number
  readonly width: number
  readonly height: number
}

export type ZoomStableHudMetrics = {
  readonly isZoomAdjusted: boolean
  readonly scale: number
  readonly inverseScale: number
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const MIN_VIEWPORT_SCALE = 0.25
const MAX_VIEWPORT_SCALE = 8

function clampScale(rawScale: number): number {
  if (!Number.isFinite(rawScale) || rawScale <= 0) {
    return 1
  }
  return Math.max(MIN_VIEWPORT_SCALE, Math.min(MAX_VIEWPORT_SCALE, rawScale))
}

export function computeZoomStableHudMetrics(
  paneRect: PaneLayoutRect,
  viewport: VisualViewportSnapshot | null
): ZoomStableHudMetrics {
  const fallbackWidth = Math.max(120, Math.round(paneRect.width))
  const fallbackHeight = Math.max(120, Math.round(paneRect.height))
  if (!viewport) {
    return {
      isZoomAdjusted: false,
      scale: 1,
      inverseScale: 1,
      left: 0,
      top: 0,
      width: fallbackWidth,
      height: fallbackHeight
    }
  }

  const scale = clampScale(viewport.scale)
  const scaleShifted = Math.abs(scale - 1) > 0.01
  const offsetShifted = Math.abs(viewport.offsetLeft) > 0.5 || Math.abs(viewport.offsetTop) > 0.5
  if (!scaleShifted && !offsetShifted) {
    return {
      isZoomAdjusted: false,
      scale: 1,
      inverseScale: 1,
      left: 0,
      top: 0,
      width: fallbackWidth,
      height: fallbackHeight
    }
  }

  const paneRight = paneRect.left + paneRect.width
  const paneBottom = paneRect.top + paneRect.height
  const viewLeft = viewport.offsetLeft
  const viewTop = viewport.offsetTop
  const viewRight = viewport.offsetLeft + viewport.width
  const viewBottom = viewport.offsetTop + viewport.height

  const ix0 = Math.max(paneRect.left, viewLeft)
  const iy0 = Math.max(paneRect.top, viewTop)
  const ix1 = Math.min(paneRight, viewRight)
  const iy1 = Math.min(paneBottom, viewBottom)

  const localWidth = Math.max(0, ix1 - ix0)
  const localHeight = Math.max(0, iy1 - iy0)
  if (localWidth < 32 || localHeight < 32) {
    return {
      isZoomAdjusted: false,
      scale: 1,
      inverseScale: 1,
      left: 0,
      top: 0,
      width: fallbackWidth,
      height: fallbackHeight
    }
  }

  const inverseScale = 1 / scale
  return {
    isZoomAdjusted: true,
    scale,
    inverseScale,
    left: Math.round((ix0 - paneRect.left) * 100) / 100,
    top: Math.round((iy0 - paneRect.top) * 100) / 100,
    width: Math.max(120, Math.round(localWidth * scale)),
    height: Math.max(120, Math.round(localHeight * scale))
  }
}

function readWebPaneRect(
  layerNode: unknown,
  fallbackWidth: number,
  fallbackHeight: number
): PaneLayoutRect {
  if (
    globalThis.HTMLElement !== undefined &&
    layerNode instanceof globalThis.HTMLElement &&
    typeof layerNode.getBoundingClientRect === 'function'
  ) {
    const rect = layerNode.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }
    }
  }
  return {
    left: 0,
    top: 0,
    width: fallbackWidth,
    height: fallbackHeight
  }
}

export function useZoomStableViewport(
  layerRef: RefObject<View | null>,
  fallbackWidth: number,
  fallbackHeight: number
): ZoomStableHudMetrics {
  const measure = useCallback((): ZoomStableHudMetrics => {
    if (Platform.OS !== 'web' || globalThis.window === undefined) {
      return computeZoomStableHudMetrics(
        { left: 0, top: 0, width: fallbackWidth, height: fallbackHeight },
        null
      )
    }
    const vv = globalThis.window.visualViewport
    const snapshot: VisualViewportSnapshot | null = vv
      ? {
          scale: vv.scale,
          offsetLeft: vv.offsetLeft,
          offsetTop: vv.offsetTop,
          width: vv.width,
          height: vv.height
        }
      : null
    const paneRect = readWebPaneRect(layerRef.current, fallbackWidth, fallbackHeight)
    return computeZoomStableHudMetrics(paneRect, snapshot)
  }, [fallbackHeight, fallbackWidth, layerRef])

  const [metrics, setMetrics] = useState<ZoomStableHudMetrics>(measure)

  useEffect(() => {
    const sync = () => {
      const next = measure()
      setMetrics((prev) =>
        prev.isZoomAdjusted === next.isZoomAdjusted &&
        prev.scale === next.scale &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next
      )
    }
    sync()
    if (Platform.OS !== 'web' || globalThis.window === undefined) {
      return undefined
    }
    const win = globalThis.window
    const vv = win.visualViewport
    vv?.addEventListener('resize', sync)
    vv?.addEventListener('scroll', sync)
    win.addEventListener('resize', sync)
    win.addEventListener('scroll', sync, true)
    return () => {
      vv?.removeEventListener('resize', sync)
      vv?.removeEventListener('scroll', sync)
      win.removeEventListener('resize', sync)
      win.removeEventListener('scroll', sync, true)
    }
  }, [measure])

  return metrics
}
