import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'
import { PixelRatio, type Image, type View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import {
  buildMobileBrowserScreencastRequest,
  type MobileBrowserViewMode
} from './browser-screencast-request'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  getCachedBrowserFrame,
  updateBrowserLayerVisibility,
  type FrameLayer
} from './mobile-browser-frame-state'
import {
  clampBrowserZoomState,
  computeBrowserFrameGeometry,
  type BrowserTouchLayout,
  type BrowserZoomState
} from './browser-touch-geometry'
import type { MobileBrowserTab } from './MobileBrowserPane'
import {
  handleBrowserScreencastEvent,
  type BrowserDialogState,
  type ScreencastEvent
} from './mobile-browser-stream-events'
import { useMobileBrowserFrameApply } from './use-mobile-browser-frame-apply'
import { useMobileBrowserRequest } from './use-mobile-browser-request'

type PendingFrame = { frame: BrowserScreencastFrame; cacheKey: string }

type MobileBrowserStreamArgs = {
  appActive: boolean
  browserImageRefs: { current: [Image | null, Image | null] }
  browserLayerRefs: { current: [View | null, View | null] }
  browserViewMode: MobileBrowserViewMode
  busyRef: { current: boolean }
  cacheKey: string | null
  client: RpcClient | null
  frameMetadata: BrowserScreencastFrameMetadata | null
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  frameMountedRef: { current: boolean }
  frameThrottleTimerRef: { current: ReturnType<typeof setTimeout> | null }
  frameUriRef: { current: string | null }
  lastAppliedFrameAtRef: { current: number }
  lastStreamCacheKeyRef: { current: string | null }
  lastZoomResetUrlRef: { current: string }
  layout: BrowserTouchLayout | null
  pendingFrameLayerRef: { current: FrameLayer | null }
  pendingThrottledFrameRef: { current: PendingFrame | null }
  resetBrowserZoomState: () => void
  screencastSupported: boolean | null
  setAddressValue: Dispatch<SetStateAction<string>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setDialog: Dispatch<SetStateAction<BrowserDialogState | null>>
  setError: Dispatch<SetStateAction<string | null>>
  setFrameMetadata: Dispatch<SetStateAction<BrowserScreencastFrameMetadata | null>>
  setFrameUri: Dispatch<SetStateAction<string | null>>
  setZoom: Dispatch<SetStateAction<BrowserZoomState>>
  streamGenerationRef: { current: number }
  tab: MobileBrowserTab
  visibleFrameLayerRef: { current: FrameLayer }
  worktreeId: string
  zoomRef: { current: BrowserZoomState }
}

export function useMobileBrowserStream(args: MobileBrowserStreamArgs) {
  const {
    appActive,
    browserImageRefs,
    browserLayerRefs,
    browserViewMode,
    busyRef,
    cacheKey,
    client,
    frameMetadata,
    frameMetadataRef,
    frameMountedRef,
    frameThrottleTimerRef,
    frameUriRef,
    lastAppliedFrameAtRef,
    lastStreamCacheKeyRef,
    lastZoomResetUrlRef,
    layout,
    pendingFrameLayerRef,
    pendingThrottledFrameRef,
    resetBrowserZoomState,
    screencastSupported,
    setAddressValue,
    setBusy,
    setDialog,
    setError,
    setFrameMetadata,
    setFrameUri,
    setZoom,
    streamGenerationRef,
    tab,
    visibleFrameLayerRef,
    worktreeId,
    zoomRef
  } = args

  const { pageParams, sendBrowserRequest } = useMobileBrowserRequest({
    busyRef,
    client,
    pageId: tab.browserPageId,
    setBusy,
    setError,
    worktreeId
  })

  const { applyFrameThrottled, clearFrameThrottle } = useMobileBrowserFrameApply({
    browserImageRefs,
    busyRef,
    frameMetadataRef,
    frameMountedRef,
    frameThrottleTimerRef,
    frameUriRef,
    lastAppliedFrameAtRef,
    pendingFrameLayerRef,
    pendingThrottledFrameRef,
    setBusy,
    setFrameMetadata,
    setFrameUri,
    visibleFrameLayerRef
  })

  const streamRequest = useMemo(
    () => buildMobileBrowserScreencastRequest(layout, PixelRatio.get(), browserViewMode),
    [browserViewMode, layout]
  )

  const frameGeometry = useMemo(
    () => computeBrowserFrameGeometry(layout, frameMetadata),
    [frameMetadata, layout]
  )

  useEffect(() => {
    if (!frameGeometry) {
      return
    }
    setZoom((current) => {
      const next = clampBrowserZoomState(current, frameGeometry, MIN_ZOOM, MAX_ZOOM)
      if (
        next.scale === current.scale &&
        next.offsetX === current.offsetX &&
        next.offsetY === current.offsetY
      ) {
        return current
      }
      // Why: rotation/layout changes can shrink the legal pan range while the
      // current zoom state still points at the previous viewport geometry.
      zoomRef.current = next
      return next
    })
  }, [frameGeometry])

  useEffect(() => {
    streamGenerationRef.current += 1
    const generation = streamGenerationRef.current
    const sameStream = Boolean(cacheKey) && lastStreamCacheKeyRef.current === cacheKey
    lastStreamCacheKeyRef.current = cacheKey
    if (!sameStream || !frameUriRef.current) {
      const cachedFrame = getCachedBrowserFrame(cacheKey)
      if (cachedFrame) {
        frameUriRef.current = cachedFrame.uri
        frameMountedRef.current = true
        frameMetadataRef.current = cachedFrame.metadata
        setFrameUri(cachedFrame.uri)
        setFrameMetadata(cachedFrame.metadata)
      } else {
        frameUriRef.current = null
        frameMountedRef.current = false
        setFrameUri(null)
        setFrameMetadata(null)
        frameMetadataRef.current = null
      }
    } else {
      frameMountedRef.current = true
    }
    pendingFrameLayerRef.current = null
    if (!sameStream || !frameUriRef.current) {
      visibleFrameLayerRef.current = 0
    }
    updateBrowserLayerVisibility(browserLayerRefs.current, visibleFrameLayerRef.current)
    lastAppliedFrameAtRef.current = 0
    clearFrameThrottle()
    busyRef.current = false
    setDialog(null)
    setError(null)
    if (
      !client ||
      screencastSupported !== true ||
      !tab.browserPageId ||
      !appActive ||
      !streamRequest
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
      if (streamGenerationRef.current !== generation) {
        return
      }
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
        ...streamRequest
      },
      (payload) => {
        if (streamGenerationRef.current !== generation) {
          return
        }
        handleBrowserScreencastEvent({
          busyRef,
          clearStartupTimer,
          event: payload as ScreencastEvent,
          lastZoomResetUrlRef,
          resetBrowserZoomState,
          setAddressValue,
          setBusy,
          setDialog,
          setError
        })
      },
      {
        onBinaryFrame: (frame) => {
          if (streamGenerationRef.current !== generation) {
            return
          }
          clearStartupTimer()
          if (cacheKey) {
            applyFrameThrottled(frame, cacheKey)
          }
        }
      }
    )
    return () => {
      clearStartupTimer()
      clearFrameThrottle()
      unsubscribe()
    }
  }, [
    appActive,
    applyFrameThrottled,
    clearFrameThrottle,
    client,
    resetBrowserZoomState,
    screencastSupported,
    streamRequest,
    cacheKey,
    tab.browserPageId,
    worktreeId
  ])

  return { frameGeometry, pageParams, sendBrowserRequest }
}
