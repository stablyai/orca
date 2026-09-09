import { useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  PanResponder,
  type GestureResponderEvent,
  type PanResponderGestureState
} from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import {
  createPinchGesture,
  MAX_ZOOM,
  MIN_ZOOM,
  updatePinchZoom,
  type PinchGesture
} from './mobile-browser-frame-state'
import {
  clampBrowserZoomState,
  readLocalTouchPoint,
  type BrowserFrameGeometry,
  type BrowserTouchLayout,
  type BrowserZoomState
} from './browser-touch-geometry'
import type { BrowserPointerModifier } from './MobileBrowserPointerModifiers'
import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'

import { useMobileBrowserCommands } from './use-mobile-browser-commands'
const TAP_SLOP = 16
const SCROLL_START_SLOP = 22
const LONG_PRESS_MS = 550
const WHEEL_INTERVAL_MS = 70

type BrowserPageParams = { worktree: string; page: string }
type PanGesture = { x: number; y: number; offsetX: number; offsetY: number }
type SendBrowserRequest = (
  method: string,
  params?: Record<string, unknown>,
  options?: { showBusy?: boolean; suppressError?: boolean; timeoutMs?: number }
) => Promise<unknown | null>

type MobileBrowserInteractionArgs = {
  clearLongPressTimer: () => void
  client: RpcClient | null
  dialogRef: { current: { dialogType: string; message: string } | null }
  frameGeometry: BrowserFrameGeometry | null
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  keyboardValue: string
  layoutRef: { current: BrowserTouchLayout | null }
  longPressTimerRef: { current: ReturnType<typeof setTimeout> | null }
  onToast: (message: string, durationMs?: number) => void
  pageParams: () => BrowserPageParams | null
  panRef: { current: PanGesture | null }
  pinchRef: { current: PinchGesture | null }
  pointerModifiers: BrowserPointerModifier[]
  sendBrowserRequest: SendBrowserRequest
  setDialog: Dispatch<SetStateAction<{ dialogType: string; message: string } | null>>
  setError: Dispatch<SetStateAction<string | null>>
  setKeyboardValue: Dispatch<SetStateAction<string>>
  scrollingRef: { current: boolean }
  startPointRef: { current: { x: number; y: number; t: number } | null }
  setPointerModifiers: Dispatch<SetStateAction<BrowserPointerModifier[]>>
  setZoom: Dispatch<SetStateAction<BrowserZoomState>>
  zoomRef: { current: BrowserZoomState }
}

export function useMobileBrowserInteractions(args: MobileBrowserInteractionArgs) {
  const {
    clearLongPressTimer,
    client,
    dialogRef,
    frameGeometry,
    frameMetadataRef,
    keyboardValue,
    layoutRef,
    longPressTimerRef,
    onToast,
    pageParams,
    panRef,
    pinchRef,
    pointerModifiers,
    scrollingRef,
    sendBrowserRequest,
    setDialog,
    setError,
    setKeyboardValue,
    setPointerModifiers,
    setZoom,
    startPointRef,
    zoomRef
  } = args
  const rightClickSentRef = useRef(false)
  const lastWheelRef = useRef({ dx: 0, dy: 0, at: 0 })
  const wheelGestureIdRef = useRef(0)
  const {
    mapTouchPoint,
    sendDialogCommand,
    sendKeyboardText,
    sendKeypress,
    sendPointerClick,
    sendWheel,
    togglePointerModifier
  } = useMobileBrowserCommands({
    client,
    frameMetadataRef,
    keyboardValue,
    layoutRef,
    onToast,
    pageParams,
    pointerModifiers,
    sendBrowserRequest,
    setDialog,
    setError,
    setKeyboardValue,
    setPointerModifiers,
    zoomRef
  })

  const handleResponderGrant = useCallback(
    (event: GestureResponderEvent) => {
      const pinch = createPinchGesture(event, frameGeometry, zoomRef.current)
      if (pinch) {
        clearLongPressTimer()
        pinchRef.current = pinch
        panRef.current = null
        startPointRef.current = null
        return
      }
      const startPoint = readLocalTouchPoint(event.nativeEvent)
      if (!startPoint) {
        return
      }
      startPointRef.current = { x: startPoint.x, y: startPoint.y, t: Date.now() }
      rightClickSentRef.current = false
      scrollingRef.current = false
      wheelGestureIdRef.current += 1
      lastWheelRef.current = { dx: 0, dy: 0, at: 0 }
      panRef.current =
        zoomRef.current.scale > MIN_ZOOM
          ? {
              x: startPoint.x,
              y: startPoint.y,
              offsetX: zoomRef.current.offsetX,
              offsetY: zoomRef.current.offsetY
            }
          : null
      clearLongPressTimer()
      longPressTimerRef.current = setTimeout(() => {
        const start = startPointRef.current
        if (!start) {
          return
        }
        const point = mapTouchPoint(start.x, start.y)
        if (!point) {
          return
        }
        rightClickSentRef.current = true
        void sendPointerClick(point, 'right')
        onToast('Right click')
      }, LONG_PRESS_MS)
    },
    [clearLongPressTimer, frameGeometry, mapTouchPoint, onToast, sendPointerClick]
  )

  const handleResponderMove = useCallback(
    (event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      const startedPinch = pinchRef.current
        ? null
        : createPinchGesture(event, frameGeometry, zoomRef.current)
      if (startedPinch) {
        clearLongPressTimer()
        pinchRef.current = startedPinch
        panRef.current = null
        startPointRef.current = null
      }
      const activePinch = pinchRef.current
      const nextPinch = activePinch ? updatePinchZoom(event, frameGeometry, activePinch) : null
      if (nextPinch) {
        clearLongPressTimer()
        zoomRef.current = nextPinch
        setZoom(nextPinch)
        return
      }
      if (activePinch) {
        pinchRef.current = null
      }
      const moved = Math.hypot(gesture.dx, gesture.dy)
      if (moved > TAP_SLOP) {
        clearLongPressTimer()
      }
      const activePan = panRef.current
      if (activePan && frameGeometry) {
        const currentPoint = readLocalTouchPoint(event.nativeEvent)
        if (!currentPoint) {
          return
        }
        if (!scrollingRef.current && moved <= TAP_SLOP) {
          return
        }
        scrollingRef.current = true
        startPointRef.current = null
        const nextZoom = clampBrowserZoomState(
          {
            scale: zoomRef.current.scale,
            offsetX: activePan.offsetX + currentPoint.x - activePan.x,
            offsetY: activePan.offsetY + currentPoint.y - activePan.y
          },
          frameGeometry,
          MIN_ZOOM,
          MAX_ZOOM
        )
        zoomRef.current = nextZoom
        setZoom(nextZoom)
        return
      }
      if (!scrollingRef.current) {
        if (moved <= SCROLL_START_SLOP) {
          return
        }
        scrollingRef.current = true
        startPointRef.current = null
      }
      const now = Date.now()
      if (now - lastWheelRef.current.at < WHEEL_INTERVAL_MS) {
        return
      }
      const deltaX = gesture.dx - lastWheelRef.current.dx
      const deltaY = gesture.dy - lastWheelRef.current.dy
      if (Math.abs(deltaX) + Math.abs(deltaY) < 8) {
        return
      }
      const currentPoint = readLocalTouchPoint(event.nativeEvent)
      if (!currentPoint) {
        return
      }
      const point = mapTouchPoint(currentPoint.x, currentPoint.y)
      if (!point) {
        return
      }
      lastWheelRef.current = { dx: gesture.dx, dy: gesture.dy, at: now }
      sendWheel(point, deltaX, deltaY, wheelGestureIdRef.current)
    },
    [clearLongPressTimer, frameGeometry, mapTouchPoint, sendWheel]
  )

  const handleResponderRelease = useCallback(
    (event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      clearLongPressTimer()
      pinchRef.current = null
      panRef.current = null
      const start = startPointRef.current
      startPointRef.current = null
      const wasScrolling = scrollingRef.current
      scrollingRef.current = false
      if (!start || rightClickSentRef.current || wasScrolling) {
        return
      }
      const moved = Math.hypot(gesture.dx, gesture.dy)
      if (moved <= TAP_SLOP && Date.now() - start.t < LONG_PRESS_MS) {
        // Why: native browser taps resolve at touch-up. Using touch-down makes
        // tiny finger drift feel like the click lands left/up of the finger.
        const release = readLocalTouchPoint(event.nativeEvent) ?? start
        const point = mapTouchPoint(release.x, release.y)
        if (point) {
          void sendPointerClick(point, 'left')
        }
      }
    },
    [clearLongPressTimer, mapTouchPoint, sendPointerClick]
  )

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => dialogRef.current === null,
        onMoveShouldSetPanResponder: () => dialogRef.current === null,
        onPanResponderGrant: handleResponderGrant,
        onPanResponderMove: handleResponderMove,
        onPanResponderRelease: handleResponderRelease,
        onPanResponderTerminate: () => {
          clearLongPressTimer()
          pinchRef.current = null
          panRef.current = null
          scrollingRef.current = false
          startPointRef.current = null
        },
        onPanResponderTerminationRequest: () => true
      }),
    [clearLongPressTimer, handleResponderGrant, handleResponderMove, handleResponderRelease]
  )

  return { panResponder, sendDialogCommand, sendKeyboardText, sendKeypress, togglePointerModifier }
}
