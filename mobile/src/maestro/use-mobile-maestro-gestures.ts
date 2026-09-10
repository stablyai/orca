import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { PanResponder, type GestureResponderEvent } from 'react-native'
import {
  panMobileMaestroViewport,
  pinchMobileMaestroViewport,
  type MaestroViewport
} from './mobile-maestro-geometry'

const PAN_ACTIVATION_DISTANCE = 4
const MIN_PINCH_DISTANCE = 8

type Point = { x: number; y: number }
type GestureSample = { focalPoint: Point; distance: number; touchCount: number }
type ActiveGesture =
  | { kind: 'pan'; viewport: MaestroViewport; startPoint: Point }
  | {
      kind: 'pinch'
      viewport: MaestroViewport
      start: { focalPoint: Point; distance: number }
    }

export function readMobileMaestroTouchPoint(touch: unknown, viewportOrigin: Point): Point | null {
  if (!touch || typeof touch !== 'object') {
    return null
  }
  const candidate = touch as {
    locationX?: unknown
    locationY?: unknown
    pageX?: unknown
    pageY?: unknown
  }
  if (
    typeof candidate.pageX === 'number' &&
    Number.isFinite(candidate.pageX) &&
    typeof candidate.pageY === 'number' &&
    Number.isFinite(candidate.pageY)
  ) {
    return { x: candidate.pageX - viewportOrigin.x, y: candidate.pageY - viewportOrigin.y }
  }
  return typeof candidate.locationX === 'number' &&
    Number.isFinite(candidate.locationX) &&
    typeof candidate.locationY === 'number' &&
    Number.isFinite(candidate.locationY)
    ? { x: candidate.locationX, y: candidate.locationY }
    : null
}

function readGestureSample(
  event: GestureResponderEvent,
  viewportOrigin: Point
): GestureSample | null {
  const touches = event.nativeEvent.touches
  const first = readMobileMaestroTouchPoint(touches[0], viewportOrigin)
  if (!first) {
    return null
  }
  const second = readMobileMaestroTouchPoint(touches[1], viewportOrigin)
  if (!second) {
    return { focalPoint: first, distance: 0, touchCount: 1 }
  }
  return {
    focalPoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    distance: Math.hypot(first.x - second.x, first.y - second.y),
    touchCount: touches.length
  }
}

function startGesture(viewport: MaestroViewport, sample: GestureSample): ActiveGesture {
  return sample.touchCount >= 2 && sample.distance >= MIN_PINCH_DISTANCE
    ? { kind: 'pinch', viewport, start: sample }
    : { kind: 'pan', viewport, startPoint: sample.focalPoint }
}

export function shouldActivateMobileMaestroGesture(
  activeTouches: number,
  translation: Point
): boolean {
  return activeTouches >= 2 || Math.hypot(translation.x, translation.y) >= PAN_ACTIVATION_DISTANCE
}

export function useMobileMaestroGestures({
  viewport,
  viewportSize,
  viewportOriginRef,
  onViewportChange
}: {
  viewport: MaestroViewport
  viewportSize: { width: number; height: number }
  viewportOriginRef: RefObject<Point>
  onViewportChange: (viewport: MaestroViewport) => void
}): ReturnType<typeof PanResponder.create> {
  const viewportRef = useRef(viewport)
  const onViewportChangeRef = useRef(onViewportChange)
  const activeGestureRef = useRef<ActiveGesture | null>(null)
  const pendingViewportRef = useRef<MaestroViewport | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  useEffect(() => {
    viewportRef.current = viewport
    onViewportChangeRef.current = onViewportChange
  }, [onViewportChange, viewport])

  useEffect(
    () => () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    },
    []
  )

  return useMemo(() => {
    const flushViewport = () => {
      animationFrameRef.current = null
      const next = pendingViewportRef.current
      pendingViewportRef.current = null
      if (next) {
        onViewportChangeRef.current(next)
      }
    }
    const scheduleViewport = (next: MaestroViewport) => {
      viewportRef.current = next
      pendingViewportRef.current = next
      if (animationFrameRef.current === null) {
        animationFrameRef.current = requestAnimationFrame(flushViewport)
      }
    }
    const finishGesture = () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current)
        flushViewport()
      }
      activeGestureRef.current = null
    }

    return PanResponder.create({
      onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length >= 2,
      onStartShouldSetPanResponderCapture: (event) => event.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponder: (_event, gesture) =>
        shouldActivateMobileMaestroGesture(gesture.numberActiveTouches, {
          x: gesture.dx,
          y: gesture.dy
        }),
      onMoveShouldSetPanResponderCapture: (_event, gesture) =>
        shouldActivateMobileMaestroGesture(gesture.numberActiveTouches, {
          x: gesture.dx,
          y: gesture.dy
        }),
      onPanResponderGrant: (event) => {
        const sample = readGestureSample(event, viewportOriginRef.current)
        activeGestureRef.current = sample ? startGesture(viewportRef.current, sample) : null
      },
      onPanResponderMove: (event) => {
        const sample = readGestureSample(event, viewportOriginRef.current)
        if (!sample) {
          return
        }
        const expectedKind = sample.touchCount >= 2 ? 'pinch' : 'pan'
        const active = activeGestureRef.current
        if (!active || active.kind !== expectedKind) {
          activeGestureRef.current = startGesture(viewportRef.current, sample)
          return
        }
        const next =
          active.kind === 'pinch'
            ? pinchMobileMaestroViewport(active.viewport, active.start, sample, viewportSize)
            : panMobileMaestroViewport(active.viewport, {
                x: sample.focalPoint.x - active.startPoint.x,
                y: sample.focalPoint.y - active.startPoint.y
              })
        scheduleViewport(next)
      },
      onPanResponderRelease: finishGesture,
      onPanResponderTerminate: finishGesture,
      onPanResponderTerminationRequest: () => true
    })
  }, [viewportSize.height, viewportSize.width])
}
