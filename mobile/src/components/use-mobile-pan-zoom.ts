import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  type PanZoomPoint,
  type PanZoomSize,
  type PanZoomView,
  containPanZoomView,
  getFittedPanZoomView,
  getPanZoomFitScale,
  getPanZoomViewOffset,
  panView,
  zoomViewAt
} from '../../../src/shared/pan-zoom-view'
import {
  beginImageViewerSwipe,
  imageViewerReleaseVelocity,
  moveImageViewerSwipe,
  type ImageViewerSwipe
} from './image-viewer-swipe'
import { useBackClaim } from '../navigation/use-back-claim'

const DOUBLE_TAP_MS = 300
const TAP_SLOP_PX = 10
const DOUBLE_TAP_ZOOM = 2.5

type Geometry = { content: PanZoomSize; viewport: PanZoomSize; fitScale: number }
type Pinch = { mid: PanZoomPoint; distance: number }
type Tap = { at: number; point: PanZoomPoint }

/** A fitted image can follow the finger in any direction. Zoomed pans and pinches never report one. */
export type MobilePanZoomDismiss = {
  onMove: (translationX: number, translationY: number) => void
  onRelease: (
    translationX: number,
    translationY: number,
    velocityX: number,
    velocityY: number
  ) => void
  onCancel: () => void
  /** Fitted Back closes the viewer. While this is set, the claim also blocks the iOS edge swipe. */
  onBack: () => void
}

export type MobilePanZoom = {
  setCanvas: (canvas: HTMLDivElement | null) => void
  handlers: Pick<
    React.HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel'
  >
  /** Rendered pixels per content unit; 1 is actual size. */
  scale: number
  offset: PanZoomPoint | null
}

function pinchOf(points: PanZoomPoint[]): Pinch {
  const [a, b] = points
  return {
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y))
  }
}

/** Fit, pinch zoom at the fingers, drag to pan and double-tap to zoom, with pointer events so Android gets it too. */
export function useMobilePanZoom(
  content: PanZoomSize | null,
  upscale: boolean,
  dismiss?: MobilePanZoomDismiss | null
): MobilePanZoom {
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<PanZoomSize | null>(null)
  // null is the fitted view, so it follows the screen through rotation.
  const [manualView, setManualView] = useState<PanZoomView | null>(null)
  const pointers = useRef(new Map<number, PanZoomPoint>())
  const pinch = useRef<Pinch | null>(null)
  const tap = useRef<{ start: PanZoomPoint; moved: boolean } | null>(null)
  const lastTap = useRef<Tap | null>(null)
  // Updated inside the gesture, so a second finger sees the pinch before React renders it.
  const zoomRef = useRef(1)
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss ?? null
  const swipeRef = useRef<ImageViewerSwipe | null>(null)
  const commitView = (next: PanZoomView | null): PanZoomView | null => {
    zoomRef.current = next?.zoom ?? 1
    return next
  }

  const [viewContent, setViewContent] = useState(content)
  if (viewContent?.width !== content?.width || viewContent?.height !== content?.height) {
    setViewContent(content)
    setManualView(null)
    zoomRef.current = 1
  }

  useEffect(() => {
    if (!canvas) {
      return
    }
    // observe() delivers the initial size, so no synchronous measure is needed.
    const observer = new ResizeObserver(() =>
      setViewport({ width: canvas.clientWidth, height: canvas.clientHeight })
    )
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvas])

  const geometry = useMemo<Geometry | null>(
    () =>
      content && viewport
        ? {
            content,
            viewport,
            fitScale: getPanZoomFitScale(content, viewport, undefined, upscale)
          }
        : null,
    [content, viewport, upscale]
  )
  // Rotation can leave a panned view past the new edges; contain it against the current viewport.
  const view =
    manualView && geometry
      ? containPanZoomView(manualView, geometry)
      : content
        ? getFittedPanZoomView(content)
        : null

  // A dismissable viewer claims Back the whole time it is open, so the iOS edge swipe cannot pop the
  // screen out from under a sideways drag. Zoomed Back still returns to fit before that claim closes it.
  useBackClaim(
    dismiss
      ? () => {
          if (zoomRef.current !== 1) {
            setManualView(commitView(null))
            return true
          }
          dismissRef.current?.onBack()
          return true
        }
      : manualView && manualView.zoom !== 1
        ? () => {
            setManualView(commitView(null))
            return true
          }
        : null
  )

  const handlers = useMemo<MobilePanZoom['handlers']>(() => {
    const local = (event: React.PointerEvent<HTMLDivElement>): PanZoomPoint => {
      const rect = event.currentTarget.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }
    const zoomAt = (from: PanZoomView, nextZoom: number, anchor: PanZoomPoint, g: Geometry) =>
      zoomViewAt({ ...g, view: from, nextZoom, anchor, contain: true })
    const toggleZoom = (point: PanZoomPoint, g: Geometry): void => {
      setManualView((current) => {
        // A drag at fit leaves a view at zoom 1; that still counts as fitted.
        if (current && current.zoom !== 1) {
          return commitView(null)
        }
        // Prefer actual size when it is a real step up from fit; otherwise a fixed magnification.
        const actual = 1 / g.fitScale
        return commitView(
          zoomAt(getFittedPanZoomView(g.content), actual > 1.5 ? actual : DOUBLE_TAP_ZOOM, point, g)
        )
      })
    }
    const endPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
      pointers.current.delete(event.pointerId)
      pinch.current = pointers.current.size === 2 ? pinchOf([...pointers.current.values()]) : null
      const swipe = swipeRef.current
      if (swipe?.phase === 'tracking' && pointers.current.size === 0) {
        swipeRef.current = null
        tap.current = null
        if (event.type === 'pointercancel') {
          dismissRef.current?.onCancel()
        } else {
          const velocity = imageViewerReleaseVelocity(swipe, event.timeStamp)
          dismissRef.current?.onRelease(
            swipe.translationX,
            swipe.translationY,
            velocity.x,
            velocity.y
          )
        }
        return
      }
      if (pointers.current.size === 0) {
        swipeRef.current = null
      }
      if (event.type !== 'pointerup' || pointers.current.size > 0 || !tap.current) {
        return
      }
      const { start, moved } = tap.current
      tap.current = null
      if (moved || !geometry) {
        return
      }
      const now = event.timeStamp
      const previous = lastTap.current
      if (
        previous &&
        now - previous.at < DOUBLE_TAP_MS &&
        Math.hypot(start.x - previous.point.x, start.y - previous.point.y) < TAP_SLOP_PX * 3
      ) {
        lastTap.current = null
        toggleZoom(start, geometry)
        return
      }
      lastTap.current = { at: now, point: start }
    }
    return {
      onPointerDown: (event) => {
        if (!geometry) {
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        const point = local(event)
        pointers.current.set(event.pointerId, point)
        tap.current = pointers.current.size === 1 ? { start: point, moved: false } : null
        pinch.current = pointers.current.size === 2 ? pinchOf([...pointers.current.values()]) : null
        if (!dismissRef.current) {
          swipeRef.current = null
          return
        }
        if (pointers.current.size >= 2) {
          if (swipeRef.current?.phase === 'tracking') {
            dismissRef.current.onCancel()
          }
          swipeRef.current = swipeRef.current
            ? { ...swipeRef.current, phase: 'pinch', translationY: 0, velocityY: 0 }
            : null
          return
        }
        swipeRef.current = beginImageViewerSwipe(point, event.timeStamp, zoomRef.current === 1)
      },
      onPointerMove: (event) => {
        const last = pointers.current.get(event.pointerId)
        if (!last || !geometry) {
          return
        }
        const point = local(event)
        pointers.current.set(event.pointerId, point)
        if (
          tap.current &&
          Math.hypot(point.x - tap.current.start.x, point.y - tap.current.start.y) > TAP_SLOP_PX
        ) {
          tap.current.moved = true
        }
        if (swipeRef.current && dismissRef.current) {
          const before = swipeRef.current.phase
          const next = moveImageViewerSwipe(
            swipeRef.current,
            point,
            event.timeStamp,
            pointers.current.size
          )
          swipeRef.current = next
          if (before === 'tracking' && next.phase !== 'tracking') {
            dismissRef.current.onCancel()
          }
          if (next.phase === 'tracking') {
            dismissRef.current.onMove(next.translationX, next.translationY)
            return
          }
        }
        const previousPinch = pinch.current
        if (previousPinch && pointers.current.size === 2) {
          const next = pinchOf([...pointers.current.values()])
          pinch.current = next
          setManualView((current) => {
            const from = current
              ? containPanZoomView(current, geometry)
              : getFittedPanZoomView(geometry.content)
            // Zoom by the spread and carry the content under the old midpoint to the new one.
            return commitView(
              zoomViewAt({
                ...geometry,
                view: from,
                nextZoom: from.zoom * (next.distance / previousPinch.distance),
                anchor: previousPinch.mid,
                target: next.mid,
                contain: true
              })
            )
          })
          return
        }
        if (pointers.current.size !== 1) {
          return
        }
        const delta = { x: point.x - last.x, y: point.y - last.y }
        setManualView((current) => {
          const from = current
            ? containPanZoomView(current, geometry)
            : getFittedPanZoomView(geometry.content)
          return commitView(
            panView(from, delta, geometry.fitScale * from.zoom, geometry.content, geometry.viewport)
          )
        })
      },
      onPointerUp: endPointer,
      onPointerCancel: endPointer
    }
  }, [geometry])

  const scale = geometry && view ? geometry.fitScale * view.zoom : 0
  return {
    setCanvas,
    handlers,
    scale,
    offset: geometry && view ? getPanZoomViewOffset(view, geometry.viewport, scale) : null
  }
}
