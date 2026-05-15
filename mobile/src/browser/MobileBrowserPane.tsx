import { Buffer } from 'buffer'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  AppState,
  Image,
  PanResponder,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState
} from 'react-native'
import { ArrowUp, RotateCw } from 'lucide-react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type MobileBrowserTab = {
  type: 'browser'
  id: string
  title: string
  browserWorkspaceId: string
  browserPageId: string | null
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isActive: boolean
}

type MobileBrowserPaneProps = {
  client: RpcClient | null
  worktreeId: string
  tab: MobileBrowserTab
  screencastSupported: boolean | null
  keyboardLift: number
  bottomInset: number
  onToast: (message: string, durationMs?: number) => void
}

type ViewportLayout = {
  width: number
  height: number
}

type BrowserPoint = {
  x: number
  y: number
}

type FrameGeometry = {
  sourceWidth: number
  sourceHeight: number
  viewportWidth: number
  viewportHeight: number
  renderedWidth: number
  renderedHeight: number
  offsetX: number
  offsetY: number
  scale: number
  rotated: boolean
}

type StreamViewport = {
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  deviceScaleFactor: number
}

type ZoomState = {
  scale: number
  offsetX: number
  offsetY: number
}

type FrameLayer = 0 | 1

type PinchGesture = {
  distance: number
  scale: number
  anchorX: number
  anchorY: number
}

type PanGesture = {
  x: number
  y: number
  offsetX: number
  offsetY: number
}

const TAP_SLOP = 16
const SCROLL_START_SLOP = 22
const LONG_PRESS_MS = 550
const WHEEL_INTERVAL_MS = 70
const BROWSER_FRAME_FORMAT = 'jpeg'
const BROWSER_FRAME_QUALITY = 72
const BROWSER_FRAME_EVERY_NTH_FRAME = 3
const BROWSER_FRAME_MIN_INTERVAL_MS = 100
const BROWSER_MIN_VIEWPORT_WIDTH = 320
const BROWSER_MIN_VIEWPORT_HEIGHT = 240
const BROWSER_MAX_VIEWPORT_WIDTH = 2400
const BROWSER_MAX_VIEWPORT_HEIGHT = 2160
const BROWSER_MAX_STREAM_SCALE = 2.5
const MIN_ZOOM = 1
const MAX_ZOOM = 3.5
const DEFAULT_ZOOM: ZoomState = { scale: 1, offsetX: 0, offsetY: 0 }

export function MobileBrowserPane({
  client,
  worktreeId,
  tab,
  screencastSupported,
  keyboardLift,
  bottomInset,
  onToast
}: MobileBrowserPaneProps) {
  const [addressValue, setAddressValue] = useState(displayMobileBrowserUrl(tab.url))
  const [addressFocused, setAddressFocused] = useState(false)
  const [keyboardValue, setKeyboardValue] = useState('')
  const [frameUri, setFrameUri] = useState<string | null>(null)
  const [frameMetadata, setFrameMetadata] = useState<BrowserScreencastFrameMetadata | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rotated, setRotated] = useState(false)
  const [zoom, setZoom] = useState<ZoomState>(DEFAULT_ZOOM)
  const [layout, setLayout] = useState<ViewportLayout | null>(null)
  const [appActive, setAppActive] = useState(AppState.currentState === 'active')
  const streamGenerationRef = useRef(0)
  const layoutRef = useRef<ViewportLayout | null>(null)
  const frameMetadataRef = useRef<BrowserScreencastFrameMetadata | null>(null)
  const frameUriRef = useRef<string | null>(null)
  const frameMountedRef = useRef(false)
  const browserImageRefs = useRef<[Image | null, Image | null]>([null, null])
  const browserLayerRefs = useRef<[View | null, View | null]>([null, null])
  const pendingFrameLayerRef = useRef<FrameLayer | null>(null)
  const visibleFrameLayerRef = useRef<FrameLayer>(0)
  const readyRef = useRef(false)
  const busyRef = useRef(false)
  const lastAppliedFrameAtRef = useRef(0)
  const rotatedRef = useRef(false)
  const startPointRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rightClickSentRef = useRef(false)
  const lastWheelRef = useRef<{ dx: number; dy: number; at: number }>({ dx: 0, dy: 0, at: 0 })
  const zoomRef = useRef<ZoomState>(DEFAULT_ZOOM)
  const pinchRef = useRef<PinchGesture | null>(null)
  const panRef = useRef<PanGesture | null>(null)
  const scrollingRef = useRef(false)
  const lastZoomResetUrlRef = useRef(tab.url || 'about:blank')

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const resetZoomState = useCallback(() => {
    clearLongPressTimer()
    pinchRef.current = null
    panRef.current = null
    scrollingRef.current = false
    startPointRef.current = null
    zoomRef.current = DEFAULT_ZOOM
    setZoom(DEFAULT_ZOOM)
  }, [clearLongPressTimer])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppActive(nextState === 'active')
    })
    return () => {
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!addressFocused) {
      setAddressValue(displayMobileBrowserUrl(tab.url))
    }
  }, [addressFocused, tab.url])

  useEffect(() => {
    frameMetadataRef.current = frameMetadata
  }, [frameMetadata])

  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  useEffect(() => {
    rotatedRef.current = rotated
  }, [rotated])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    lastZoomResetUrlRef.current = tab.url || 'about:blank'
    resetZoomState()
  }, [resetZoomState, rotated, tab.browserPageId, tab.url])

  const pageParams = useCallback(() => {
    if (!tab.browserPageId) {
      return null
    }
    return {
      worktree: `id:${worktreeId}`,
      page: tab.browserPageId
    }
  }, [tab.browserPageId, worktreeId])

  const applyFrame = useCallback((frame: BrowserScreencastFrame): void => {
    if (!browserFrameMetadataEqual(frameMetadataRef.current, frame.metadata)) {
      frameMetadataRef.current = frame.metadata
      setFrameMetadata(frame.metadata)
    }
    const nextFrameUri = createBrowserFrameDataUri(frame)
    if (!frameMountedRef.current) {
      frameUriRef.current = nextFrameUri
      frameMountedRef.current = true
      setFrameUri(nextFrameUri)
      updateBrowserImageSource(browserImageRefs.current[0], nextFrameUri)
    } else if (pendingFrameLayerRef.current === null) {
      // Why: decode the next frame offscreen and keep the previous layer visible
      // until onLoad; replacing the visible Image directly flashes black.
      const nextLayer: FrameLayer = visibleFrameLayerRef.current === 0 ? 1 : 0
      frameUriRef.current = nextFrameUri
      pendingFrameLayerRef.current = nextLayer
      updateBrowserImageSource(browserImageRefs.current[nextLayer], nextFrameUri)
    }
    if (busyRef.current) {
      busyRef.current = false
      setBusy(false)
    }
    if (!readyRef.current) {
      readyRef.current = true
      setReady(true)
    }
  }, [])

  const streamViewport = useMemo(() => computeStreamViewport(layout, rotated), [layout, rotated])

  const frameGeometry = useMemo(
    () => computeFrameGeometry(layout, frameMetadata, rotated),
    [frameMetadata, layout, rotated]
  )

  useEffect(() => {
    streamGenerationRef.current += 1
    const generation = streamGenerationRef.current
    frameUriRef.current = null
    frameMountedRef.current = false
    pendingFrameLayerRef.current = null
    visibleFrameLayerRef.current = 0
    updateBrowserLayerVisibility(browserLayerRefs.current, 0)
    setFrameUri(null)
    setFrameMetadata(null)
    frameMetadataRef.current = null
    lastAppliedFrameAtRef.current = 0
    readyRef.current = false
    busyRef.current = false
    setReady(false)
    setError(null)
    if (
      !client ||
      screencastSupported !== true ||
      !tab.browserPageId ||
      !appActive ||
      !streamViewport
    ) {
      busyRef.current = false
      setBusy(false)
      if (screencastSupported === false) {
        setError('Update desktop Orca to stream browser tabs on mobile.')
      } else if (screencastSupported === null) {
        setError('Checking desktop browser streaming support.')
      } else if (!tab.browserPageId) {
        setError('Browser page is not available yet.')
      }
      return
    }
    busyRef.current = true
    setBusy(true)
    let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (streamGenerationRef.current !== generation) return
      busyRef.current = false
      setBusy(false)
      setError('Browser stream timed out.')
    }, 15_000)
    const clearStartupTimer = (): void => {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
    }
    const unsubscribe = client.subscribe(
      'browser.screencast',
      {
        worktree: `id:${worktreeId}`,
        page: tab.browserPageId,
        format: BROWSER_FRAME_FORMAT,
        quality: BROWSER_FRAME_QUALITY,
        maxWidth: streamViewport.width,
        maxHeight: streamViewport.height,
        viewportWidth: streamViewport.viewportWidth,
        viewportHeight: streamViewport.viewportHeight,
        deviceScaleFactor: streamViewport.deviceScaleFactor,
        everyNthFrame: BROWSER_FRAME_EVERY_NTH_FRAME,
        minFrameIntervalMs: BROWSER_FRAME_MIN_INTERVAL_MS
      },
      (payload) => {
        if (streamGenerationRef.current !== generation) return
        const event = payload as {
          type?: string
          message?: string
          error?: { message?: string }
          tab?: { url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean }
        }
        if (event.type === 'ready') {
          clearStartupTimer()
          if (!readyRef.current) {
            readyRef.current = true
            setReady(true)
          }
          if (busyRef.current) {
            busyRef.current = false
            setBusy(false)
          }
          if (typeof event.tab?.url === 'string') {
            setAddressValue(displayMobileBrowserUrl(event.tab.url))
            if (event.tab.url !== lastZoomResetUrlRef.current) {
              lastZoomResetUrlRef.current = event.tab.url
              resetZoomState()
            }
          }
        } else if (event.type === 'end') {
          clearStartupTimer()
          if (readyRef.current) {
            readyRef.current = false
            setReady(false)
          }
          if (busyRef.current) {
            busyRef.current = false
            setBusy(false)
          }
        } else if (event.type === 'error') {
          clearStartupTimer()
          if (busyRef.current) {
            busyRef.current = false
            setBusy(false)
          }
          const message = event.message ?? event.error?.message ?? 'Browser stream failed.'
          if (shouldSurfaceBrowserError(message)) {
            if (readyRef.current) {
              readyRef.current = false
              setReady(false)
            }
            setError(message)
          }
        }
      },
      {
        onBinaryFrame: (frame) => {
          if (streamGenerationRef.current !== generation) return
          clearStartupTimer()
          const now = Date.now()
          // Why: each image swap crosses RN's native boundary; applying every
          // desktop screencast frame can starve tab switching on the phone.
          if (
            lastAppliedFrameAtRef.current > 0 &&
            now - lastAppliedFrameAtRef.current < BROWSER_FRAME_MIN_INTERVAL_MS
          ) {
            return
          }
          lastAppliedFrameAtRef.current = now
          applyFrame(frame)
        }
      }
    )
    return () => {
      clearStartupTimer()
      unsubscribe()
    }
  }, [
    appActive,
    applyFrame,
    client,
    resetZoomState,
    screencastSupported,
    streamViewport,
    tab.browserPageId,
    worktreeId
  ])

  const sendBrowserRequest = useCallback(
    async (
      method: string,
      params: Record<string, unknown> = {},
      opts: { showBusy?: boolean; suppressError?: boolean; timeoutMs?: number } = {}
    ): Promise<unknown | null> => {
      const base = pageParams()
      if (!client || !base) {
        return null
      }
      if (opts.showBusy) {
        busyRef.current = true
        setBusy(true)
      }
      try {
        const response = await client.sendRequest(
          method,
          { ...base, ...params },
          { timeoutMs: opts.timeoutMs ?? 15_000 }
        )
        if (!response.ok) {
          throw new Error((response as RpcFailure).error.message)
        }
        setError(null)
        return (response as RpcSuccess).result
      } catch (err) {
        const message = browserErrorMessage(err, 'Browser command failed')
        if (!opts.suppressError && shouldSurfaceBrowserError(message)) {
          setError(message)
        }
        return null
      } finally {
        if (opts.showBusy) {
          busyRef.current = false
          setBusy(false)
        }
      }
    },
    [client, pageParams]
  )

  const navigateToAddress = useCallback(async () => {
    const url = normalizeMobileBrowserUrl(addressValue)
    if (!url) {
      setError('Enter a valid URL.')
      return
    }
    const result = (await sendBrowserRequest(
      'browser.goto',
      { url },
      { showBusy: true, timeoutMs: 30_000 }
    )) as { url?: string } | null
    if (typeof result?.url === 'string') {
      setAddressValue(displayMobileBrowserUrl(result.url))
      lastZoomResetUrlRef.current = result.url
      resetZoomState()
    }
  }, [addressValue, resetZoomState, sendBrowserRequest])

  const sendPointerClick = useCallback(
    async (point: BrowserPoint, button: 'left' | 'right') => {
      const base = pageParams()
      if (!client || !base) {
        return
      }
      const clickResult = await sendBrowserRequest(
        'browser.mouseClick',
        {
          x: point.x,
          y: point.y,
          button,
          ...(button === 'left'
            ? {
                radius: computeTouchClickRadiusCss(
                  layoutRef.current,
                  frameMetadataRef.current,
                  rotatedRef.current,
                  zoomRef.current
                )
              }
            : {})
        },
        { suppressError: true, timeoutMs: 5_000 }
      )
      if (clickResult !== null) {
        return
      }
      try {
        assertRpcOk(
          await client.sendRequest('browser.mouseMove', { ...base, x: point.x, y: point.y }),
          'Browser pointer move failed'
        )
        assertRpcOk(
          await client.sendRequest('browser.mouseDown', { ...base, button }),
          'Browser pointer down failed'
        )
        assertRpcOk(
          await client.sendRequest('browser.mouseUp', { ...base, button }),
          'Browser pointer up failed'
        )
        setError(null)
      } catch {
        // Pointer commands can race page navigation. Keep the stream visible;
        // actionable failures still surface through navigation/stream errors.
      }
    },
    [client, pageParams, sendBrowserRequest]
  )

  const sendWheel = useCallback(
    (point: BrowserPoint, screenDx: number, screenDy: number) => {
      const base = pageParams()
      if (!client || !base) {
        return
      }
      const currentLayout = layoutRef.current
      const geometry = computeFrameGeometry(
        currentLayout,
        frameMetadataRef.current,
        rotatedRef.current
      )
      const localZoom = zoomRef.current.scale
      const scale = (geometry?.scale ?? 1) * localZoom
      const cssDx = screenDx / scale
      const cssDy = screenDy / scale
      const delta = rotatedRef.current
        ? { dx: Math.round(-cssDy), dy: Math.round(cssDx) }
        : { dx: Math.round(-cssDx), dy: Math.round(-cssDy) }
      if (Math.abs(delta.dx) < 1 && Math.abs(delta.dy) < 1) {
        return
      }
      void (async () => {
        try {
          assertRpcOk(
            await client.sendRequest('browser.mouseMove', { ...base, x: point.x, y: point.y }),
            'Browser pointer move failed'
          )
          assertRpcOk(
            await client.sendRequest('browser.mouseWheel', { ...base, dx: delta.dx, dy: delta.dy }),
            'Browser scroll failed'
          )
          setError(null)
        } catch {
          // Scroll bursts commonly race page reload/navigation. Avoid replacing
          // the live browser with transient command errors like selector_not_found.
        }
      })()
    },
    [client, pageParams]
  )

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer])

  const mapTouchPoint = useCallback((locationX: number, locationY: number): BrowserPoint | null => {
    const currentLayout = layoutRef.current
    const metadata = frameMetadataRef.current
    const geometry = computeFrameGeometry(currentLayout, metadata, rotatedRef.current)
    if (!geometry) {
      return null
    }
    const zoomState = zoomRef.current
    const local = screenToFrameLocal(locationX, locationY, geometry, zoomState)
    if (!local) {
      return null
    }
    const { localX, localY } = local
    if (
      localX < 0 ||
      localY < 0 ||
      localX > geometry.renderedWidth ||
      localY > geometry.renderedHeight
    ) {
      return null
    }
    if (rotatedRef.current) {
      return {
        x: clamp(
          Math.round((localY / geometry.renderedHeight) * geometry.sourceWidth),
          0,
          geometry.sourceWidth
        ),
        y: clamp(
          Math.round(
            ((geometry.renderedWidth - localX) / geometry.renderedWidth) * geometry.sourceHeight
          ),
          0,
          geometry.sourceHeight
        )
      }
    }
    return {
      x: clamp(
        Math.round((localX / geometry.renderedWidth) * geometry.sourceWidth),
        0,
        geometry.sourceWidth
      ),
      y: clamp(
        Math.round((localY / geometry.renderedHeight) * geometry.sourceHeight),
        0,
        geometry.sourceHeight
      )
    }
  }, [])

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
      const { locationX, locationY } = event.nativeEvent
      startPointRef.current = { x: locationX, y: locationY, t: Date.now() }
      rightClickSentRef.current = false
      scrollingRef.current = false
      lastWheelRef.current = { dx: 0, dy: 0, at: 0 }
      panRef.current =
        zoomRef.current.scale > MIN_ZOOM
          ? {
              x: locationX,
              y: locationY,
              offsetX: zoomRef.current.offsetX,
              offsetY: zoomRef.current.offsetY
            }
          : null
      clearLongPressTimer()
      longPressTimerRef.current = setTimeout(() => {
        const start = startPointRef.current
        if (!start) return
        const point = mapTouchPoint(start.x, start.y)
        if (!point) return
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
        if (!scrollingRef.current && moved <= TAP_SLOP) {
          return
        }
        scrollingRef.current = true
        startPointRef.current = null
        const nextZoom = clampZoomState(
          {
            scale: zoomRef.current.scale,
            offsetX: activePan.offsetX + event.nativeEvent.locationX - activePan.x,
            offsetY: activePan.offsetY + event.nativeEvent.locationY - activePan.y
          },
          frameGeometry
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
      const point = mapTouchPoint(event.nativeEvent.locationX, event.nativeEvent.locationY)
      if (!point) {
        return
      }
      lastWheelRef.current = { dx: gesture.dx, dy: gesture.dy, at: now }
      sendWheel(point, deltaX, deltaY)
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
        const point = mapTouchPoint(start.x, start.y)
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
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
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

  const sendKeyboardText = useCallback(async () => {
    const text = keyboardValue
    if (!text) {
      return
    }
    setKeyboardValue('')
    const result = await sendBrowserRequest(
      'browser.keyboardInsertText',
      { text },
      { suppressError: true }
    )
    if (result !== null) {
      onToast('Sent')
    } else {
      setKeyboardValue(text)
    }
  }, [keyboardValue, onToast, sendBrowserRequest])

  const sendKeypress = useCallback(
    async (key: string) => {
      await sendBrowserRequest('browser.keypress', { key }, { suppressError: true })
    },
    [sendBrowserRequest]
  )

  const setBrowserImageRef = useCallback((layer: FrameLayer, image: Image | null) => {
    browserImageRefs.current[layer] = image
    const currentFrameUri = frameUriRef.current
    if (image && currentFrameUri) {
      updateBrowserImageSource(image, currentFrameUri)
    }
  }, [])
  const setBrowserLayerRef = useCallback((layer: FrameLayer, view: View | null) => {
    browserLayerRefs.current[layer] = view
    updateBrowserLayerVisibility(browserLayerRefs.current, visibleFrameLayerRef.current)
  }, [])
  const setBrowserLayer0Ref = useCallback(
    (view: View | null) => setBrowserLayerRef(0, view),
    [setBrowserLayerRef]
  )
  const setBrowserLayer1Ref = useCallback(
    (view: View | null) => setBrowserLayerRef(1, view),
    [setBrowserLayerRef]
  )
  const setBrowserImageLayer0Ref = useCallback(
    (image: Image | null) => setBrowserImageRef(0, image),
    [setBrowserImageRef]
  )
  const setBrowserImageLayer1Ref = useCallback(
    (image: Image | null) => setBrowserImageRef(1, image),
    [setBrowserImageRef]
  )

  const handleBrowserImageLoad = useCallback((layer: FrameLayer) => {
    if (pendingFrameLayerRef.current !== layer) {
      return
    }
    pendingFrameLayerRef.current = null
    visibleFrameLayerRef.current = layer
    updateBrowserLayerVisibility(browserLayerRefs.current, layer)
  }, [])
  const handleBrowserImageLayer0Load = useCallback(
    () => handleBrowserImageLoad(0),
    [handleBrowserImageLoad]
  )
  const handleBrowserImageLayer1Load = useCallback(
    () => handleBrowserImageLoad(1),
    [handleBrowserImageLoad]
  )
  const handleBrowserImageError = useCallback((layer: FrameLayer) => {
    if (pendingFrameLayerRef.current === layer) {
      pendingFrameLayerRef.current = null
    }
  }, [])
  const handleBrowserImageLayer0Error = useCallback(
    () => handleBrowserImageError(0),
    [handleBrowserImageError]
  )
  const handleBrowserImageLayer1Error = useCallback(
    () => handleBrowserImageError(1),
    [handleBrowserImageError]
  )

  const controlsDisabled = !client || !tab.browserPageId || screencastSupported !== true
  const initialFrameSource = useMemo(() => (frameUri ? { uri: frameUri } : null), [frameUri])
  const frameLayerStyle = useCallback((layer: FrameLayer) => {
    return [
      styles.browserImageLayer,
      visibleFrameLayerRef.current !== layer && styles.browserImageLayerHidden
    ]
  }, [])
  const browserLayerRef = useCallback(
    (layer: FrameLayer) => (layer === 0 ? setBrowserLayer0Ref : setBrowserLayer1Ref),
    [setBrowserLayer0Ref, setBrowserLayer1Ref]
  )
  const frameLayerRef = useCallback(
    (layer: FrameLayer) => (layer === 0 ? setBrowserImageLayer0Ref : setBrowserImageLayer1Ref),
    [setBrowserImageLayer0Ref, setBrowserImageLayer1Ref]
  )
  const frameLayerLoadHandler = useCallback(
    (layer: FrameLayer) =>
      layer === 0 ? handleBrowserImageLayer0Load : handleBrowserImageLayer1Load,
    [handleBrowserImageLayer0Load, handleBrowserImageLayer1Load]
  )
  const frameLayerErrorHandler = useCallback(
    (layer: FrameLayer) =>
      layer === 0 ? handleBrowserImageLayer0Error : handleBrowserImageLayer1Error,
    [handleBrowserImageLayer0Error, handleBrowserImageLayer1Error]
  )

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <TextInput
          style={styles.addressInput}
          value={addressValue}
          onChangeText={setAddressValue}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
          onSubmitEditing={() => void navigateToAddress()}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
          numberOfLines={1}
          returnKeyType="go"
          placeholder="URL"
          placeholderTextColor={colors.textMuted}
          editable={!controlsDisabled}
        />
        <IconButton
          disabled={controlsDisabled}
          label="Rotate browser"
          selected={rotated}
          onPress={() => setRotated((value) => !value)}
        >
          <RotateCw size={16} color={buttonColor(!controlsDisabled)} />
        </IconButton>
      </View>

      <View
        style={styles.viewport}
        onLayout={(event) => {
          const next = {
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height
          }
          const current = layoutRef.current
          if (current && current.width === next.width && current.height === next.height) {
            return
          }
          layoutRef.current = next
          setLayout(next)
        }}
        {...panResponder.panHandlers}
      >
        {initialFrameSource ? (
          <View style={styles.browserImageHost}>
            {frameGeometry ? (
              <View
                pointerEvents="none"
                style={[
                  styles.browserZoomOffset,
                  {
                    width: frameGeometry.renderedWidth,
                    height: frameGeometry.renderedHeight,
                    transform: [{ translateX: zoom.offsetX }, { translateY: zoom.offsetY }]
                  }
                ]}
              >
                <View
                  style={[
                    styles.browserFrameBox,
                    {
                      width: frameGeometry.renderedWidth,
                      height: frameGeometry.renderedHeight,
                      transform: [{ scale: zoom.scale }]
                    }
                  ]}
                >
                  {([0, 1] as const).map((layer) => (
                    <View
                      key={layer}
                      ref={browserLayerRef(layer)}
                      pointerEvents="none"
                      style={frameLayerStyle(layer)}
                    >
                      <Image
                        ref={frameLayerRef(layer)}
                        source={initialFrameSource}
                        resizeMode="stretch"
                        fadeDuration={0}
                        onLoad={frameLayerLoadHandler(layer)}
                        onError={frameLayerErrorHandler(layer)}
                        style={
                          frameGeometry.rotated
                            ? [
                                styles.browserImage,
                                {
                                  width: frameGeometry.renderedHeight,
                                  height: frameGeometry.renderedWidth,
                                  transform: [{ rotate: '90deg' }]
                                }
                              ]
                            : [
                                styles.browserImage,
                                {
                                  width: frameGeometry.renderedWidth,
                                  height: frameGeometry.renderedHeight
                                }
                              ]
                        }
                      />
                    </View>
                  ))}
                </View>
              </View>
            ) : (
              ([0, 1] as const).map((layer) => (
                <View
                  key={layer}
                  ref={browserLayerRef(layer)}
                  pointerEvents="none"
                  style={frameLayerStyle(layer)}
                >
                  <Image
                    ref={frameLayerRef(layer)}
                    source={initialFrameSource}
                    resizeMode="contain"
                    fadeDuration={0}
                    onLoad={frameLayerLoadHandler(layer)}
                    onError={frameLayerErrorHandler(layer)}
                    style={styles.browserImageFill}
                  />
                </View>
              ))
            )}
          </View>
        ) : null}
        {!initialFrameSource || busy || error ? (
          <View pointerEvents="none" style={styles.overlay}>
            {busy || (!ready && !error) ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : null}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>
        ) : null}
      </View>

      <View
        style={[
          styles.keyboardDock,
          { paddingBottom: bottomInset, transform: [{ translateY: -keyboardLift }] }
        ]}
      >
        <View style={styles.keyRow}>
          {['Enter', 'Backspace', 'Tab', 'Escape'].map((key) => (
            <Pressable
              key={key}
              style={({ pressed }) => [
                styles.keyButton,
                pressed && styles.keyButtonPressed,
                controlsDisabled && styles.disabled
              ]}
              disabled={controlsDisabled}
              onPress={() => void sendKeypress(key)}
            >
              <Text style={[styles.keyButtonText, controlsDisabled && styles.disabledText]}>
                {key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.keyboardInput}
            value={keyboardValue}
            onChangeText={setKeyboardValue}
            placeholder="Type on page…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!controlsDisabled}
            onSubmitEditing={() => void sendKeyboardText()}
          />
          <Pressable
            style={[styles.sendButton, (controlsDisabled || !keyboardValue) && styles.disabled]}
            disabled={controlsDisabled || !keyboardValue}
            onPress={() => void sendKeyboardText()}
            accessibilityLabel="Send text to browser"
          >
            <ArrowUp size={18} color={buttonColor(!controlsDisabled && !!keyboardValue)} />
          </Pressable>
        </View>
      </View>
    </View>
  )
}

function IconButton({
  children,
  disabled,
  label,
  onPress,
  selected
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onPress: () => void
  selected?: boolean
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.iconButton,
        selected && styles.iconButtonSelected,
        pressed && styles.iconButtonPressed,
        disabled && styles.disabled
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={label}
    >
      {children}
    </Pressable>
  )
}

function buttonColor(enabled: boolean): string {
  return enabled ? colors.textSecondary : colors.textMuted
}

function createBrowserFrameDataUri(frame: BrowserScreencastFrame): string {
  return `data:image/${frame.format};base64,${Buffer.from(frame.image).toString('base64')}`
}

function updateBrowserLayerVisibility(
  layers: [View | null, View | null],
  visible: FrameLayer
): void {
  for (const [index, layer] of layers.entries()) {
    layer?.setNativeProps({ style: { opacity: index === visible ? 1 : 0 } })
  }
}

function updateBrowserImageSource(image: Image | null, uri: string): void {
  // Why: browser frames are large strings; mutating only the native Image
  // source avoids re-rendering the whole tab view for every streamed frame.
  const source = [{ uri }]
  image?.setNativeProps({ source, src: source })
}

function assertRpcOk(
  response: RpcSuccess | RpcFailure,
  fallbackMessage: string
): asserts response is RpcSuccess {
  if (!response.ok) {
    throw new Error(response.error.message || fallbackMessage)
  }
}

function normalizeMobileBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || isBlankMobileBrowserUrl(trimmed)) {
    return 'about:blank'
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'file:'
      ? parsed.toString()
      : null
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString()
    } catch {
      return null
    }
  }
}

function displayMobileBrowserUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  return isBlankMobileBrowserUrl(trimmed) ? 'about:blank' : trimmed
}

function isBlankMobileBrowserUrl(value: string): boolean {
  return !value || value === 'about:blank' || value.startsWith('data:text/html')
}

function getPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function browserFrameMetadataEqual(
  a: BrowserScreencastFrameMetadata | null,
  b: BrowserScreencastFrameMetadata
): boolean {
  return (
    a?.deviceWidth === b.deviceWidth &&
    a?.deviceHeight === b.deviceHeight &&
    a?.pageScaleFactor === b.pageScaleFactor
  )
}

function computeStreamViewport(
  layout: ViewportLayout | null,
  rotated: boolean
): StreamViewport | null {
  if (!layout || layout.width <= 0 || layout.height <= 0) {
    return null
  }
  // Why: React Native layout is in density-independent points; requesting
  // point-sized frames makes desktop pages unreadably soft on high-DPI phones.
  const streamScale = clamp(PixelRatio.get(), 1, BROWSER_MAX_STREAM_SCALE)
  const viewportWidth = rotated ? layout.height : layout.width
  const viewportHeight = rotated ? layout.width : layout.height
  const width = viewportWidth * streamScale
  const height = viewportHeight * streamScale
  return {
    width: clamp(Math.round(width), BROWSER_MIN_VIEWPORT_WIDTH, BROWSER_MAX_VIEWPORT_WIDTH),
    height: clamp(Math.round(height), BROWSER_MIN_VIEWPORT_HEIGHT, BROWSER_MAX_VIEWPORT_HEIGHT),
    viewportWidth: clamp(
      Math.round(viewportWidth),
      BROWSER_MIN_VIEWPORT_WIDTH,
      BROWSER_MAX_VIEWPORT_WIDTH
    ),
    viewportHeight: clamp(
      Math.round(viewportHeight),
      BROWSER_MIN_VIEWPORT_HEIGHT,
      BROWSER_MAX_VIEWPORT_HEIGHT
    ),
    deviceScaleFactor: streamScale
  }
}

function computeFrameGeometry(
  layout: ViewportLayout | null,
  metadata: BrowserScreencastFrameMetadata | null,
  rotated: boolean
): FrameGeometry | null {
  if (!layout || layout.width <= 0 || layout.height <= 0) {
    return null
  }
  const sourceWidth = getPositiveFiniteNumber(metadata?.deviceWidth) ?? layout.width
  const sourceHeight = getPositiveFiniteNumber(metadata?.deviceHeight) ?? layout.height
  const visualSourceWidth = rotated ? sourceHeight : sourceWidth
  const visualSourceHeight = rotated ? sourceWidth : sourceHeight
  const scale = Math.min(layout.width / visualSourceWidth, layout.height / visualSourceHeight)
  if (!Number.isFinite(scale) || scale <= 0) {
    return null
  }
  const renderedWidth = visualSourceWidth * scale
  const renderedHeight = visualSourceHeight * scale
  return {
    sourceWidth,
    sourceHeight,
    viewportWidth: layout.width,
    viewportHeight: layout.height,
    renderedWidth,
    renderedHeight,
    offsetX: (layout.width - renderedWidth) / 2,
    offsetY: (layout.height - renderedHeight) / 2,
    scale,
    rotated
  }
}

function browserErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function shouldSurfaceBrowserError(message: string): boolean {
  const normalized = message.toLowerCase()
  // Why: selector_not_found can be emitted by in-flight page automation while
  // the browser is still usable; replacing the frame with it feels like a crash.
  return !normalized.includes('selector_not_found') && !normalized.includes('selector not found')
}

function computeTouchClickRadiusCss(
  layout: ViewportLayout | null,
  metadata: BrowserScreencastFrameMetadata | null,
  rotated: boolean,
  zoom: ZoomState
): number {
  const geometry = computeFrameGeometry(layout, metadata, rotated)
  const scale = geometry ? geometry.scale * zoom.scale : 1
  if (!Number.isFinite(scale) || scale <= 0) {
    return 10
  }
  // Why: phone taps are finger-sized while CDP clicks are pixel exact. Convert a
  // small screen radius back into page CSS pixels so tiny links remain hittable.
  return clamp(Math.round(10 / scale), 4, 24)
}

function screenToFrameLocal(
  x: number,
  y: number,
  geometry: FrameGeometry,
  zoom: ZoomState
): { localX: number; localY: number } | null {
  if (zoom.scale <= 0) {
    return null
  }
  const frameCenterX = geometry.offsetX + geometry.renderedWidth / 2 + zoom.offsetX
  const frameCenterY = geometry.offsetY + geometry.renderedHeight / 2 + zoom.offsetY
  return {
    localX: (x - frameCenterX) / zoom.scale + geometry.renderedWidth / 2,
    localY: (y - frameCenterY) / zoom.scale + geometry.renderedHeight / 2
  }
}

function touchPoint(touch: unknown): BrowserPoint | null {
  if (!touch || typeof touch !== 'object') {
    return null
  }
  const eventTouch = touch as {
    locationX?: unknown
    locationY?: unknown
    pageX?: unknown
    pageY?: unknown
  }
  if (
    typeof eventTouch.locationX === 'number' &&
    Number.isFinite(eventTouch.locationX) &&
    typeof eventTouch.locationY === 'number' &&
    Number.isFinite(eventTouch.locationY)
  ) {
    return { x: eventTouch.locationX, y: eventTouch.locationY }
  }
  if (
    typeof eventTouch.pageX === 'number' &&
    Number.isFinite(eventTouch.pageX) &&
    typeof eventTouch.pageY === 'number' &&
    Number.isFinite(eventTouch.pageY)
  ) {
    return { x: eventTouch.pageX, y: eventTouch.pageY }
  }
  return null
}

function touchPair(event: GestureResponderEvent): { a: BrowserPoint; b: BrowserPoint } | null {
  const touches = event.nativeEvent.touches
  if (!touches || touches.length < 2) {
    return null
  }
  const a = touchPoint(touches[0])
  const b = touchPoint(touches[1])
  return a && b ? { a, b } : null
}

function pointDistance(a: BrowserPoint, b: BrowserPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function createPinchGesture(
  event: GestureResponderEvent,
  geometry: FrameGeometry | null,
  zoom: ZoomState
): PinchGesture | null {
  if (!geometry) {
    return null
  }
  const pair = touchPair(event)
  if (!pair) {
    return null
  }
  const distance = pointDistance(pair.a, pair.b)
  if (distance < 8) {
    return null
  }
  const centerX = (pair.a.x + pair.b.x) / 2
  const centerY = (pair.a.y + pair.b.y) / 2
  const frameCenterX = geometry.offsetX + geometry.renderedWidth / 2 + zoom.offsetX
  const frameCenterY = geometry.offsetY + geometry.renderedHeight / 2 + zoom.offsetY
  return {
    distance,
    scale: zoom.scale,
    anchorX: (centerX - frameCenterX) / zoom.scale,
    anchorY: (centerY - frameCenterY) / zoom.scale
  }
}

function updatePinchZoom(
  event: GestureResponderEvent,
  geometry: FrameGeometry | null,
  pinch: PinchGesture
): ZoomState | null {
  if (!geometry) {
    return null
  }
  const pair = touchPair(event)
  if (!pair) {
    return null
  }
  const nextScale = clamp(
    (pinch.scale * pointDistance(pair.a, pair.b)) / pinch.distance,
    MIN_ZOOM,
    MAX_ZOOM
  )
  const centerX = (pair.a.x + pair.b.x) / 2
  const centerY = (pair.a.y + pair.b.y) / 2
  const baseCenterX = geometry.offsetX + geometry.renderedWidth / 2
  const baseCenterY = geometry.offsetY + geometry.renderedHeight / 2
  return clampZoomState(
    {
      scale: nextScale,
      offsetX: centerX - baseCenterX - pinch.anchorX * nextScale,
      offsetY: centerY - baseCenterY - pinch.anchorY * nextScale
    },
    geometry
  )
}

function clampZoomState(next: ZoomState, geometry: FrameGeometry): ZoomState {
  const scale = clamp(next.scale, MIN_ZOOM, MAX_ZOOM)
  if (scale <= MIN_ZOOM + 0.01) {
    return DEFAULT_ZOOM
  }
  const maxOffsetX = Math.max(0, (geometry.renderedWidth * scale - geometry.viewportWidth) / 2)
  const maxOffsetY = Math.max(0, (geometry.renderedHeight * scale - geometry.viewportHeight) / 2)
  return {
    scale,
    offsetX: clamp(next.offsetX, -maxOffsetX, maxOffsetX),
    offsetY: clamp(next.offsetY, -maxOffsetY, maxOffsetY)
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgBase
  },
  toolbar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  iconButtonSelected: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  addressInput: {
    flex: 1,
    minWidth: 0,
    height: 38,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    paddingHorizontal: spacing.sm,
    paddingVertical: Platform.OS === 'ios' ? 0 : 2,
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: true,
    textAlignVertical: 'center',
    fontFamily: typography.monoFamily
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: colors.bgBase
  },
  browserImageHost: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  browserImageFill: {
    width: '100%',
    height: '100%'
  },
  browserImageLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center'
  },
  browserImageLayerHidden: {
    opacity: 0
  },
  browserZoomOffset: {
    alignItems: 'center',
    justifyContent: 'center'
  },
  browserFrameBox: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  browserImage: {
    backgroundColor: colors.bgBase
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
    backgroundColor: 'rgba(13, 15, 24, 0.2)'
  },
  errorText: {
    color: colors.textPrimary,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 13,
    textAlign: 'center',
    overflow: 'hidden'
  },
  keyboardDock: {
    zIndex: 20,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  keyRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs
  },
  keyButton: {
    minHeight: 30,
    minWidth: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm
  },
  keyButtonPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs + 2
  },
  keyboardInput: {
    flex: 1,
    height: 34,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    marginRight: spacing.sm
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.35
  },
  disabledText: {
    color: colors.textMuted
  }
})
