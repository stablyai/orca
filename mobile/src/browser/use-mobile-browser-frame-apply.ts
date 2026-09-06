import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { Image } from 'react-native'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request'
import {
  browserFrameMetadataEqual,
  cacheBrowserFrame,
  createBrowserFrameDataUri,
  updateBrowserImageSource,
  type FrameLayer
} from './mobile-browser-frame-state'

type PendingFrame = { frame: BrowserScreencastFrame; cacheKey: string }
type BrowserFrameApplyArgs = {
  browserImageRefs: { current: [Image | null, Image | null] }
  busyRef: { current: boolean }
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  frameMountedRef: { current: boolean }
  frameThrottleTimerRef: { current: ReturnType<typeof setTimeout> | null }
  frameUriRef: { current: string | null }
  lastAppliedFrameAtRef: { current: number }
  pendingFrameLayerRef: { current: FrameLayer | null }
  pendingThrottledFrameRef: { current: PendingFrame | null }
  setBusy: Dispatch<SetStateAction<boolean>>
  setFrameMetadata: Dispatch<SetStateAction<BrowserScreencastFrameMetadata | null>>
  setFrameUri: Dispatch<SetStateAction<string | null>>
  visibleFrameLayerRef: { current: FrameLayer }
}
export function useMobileBrowserFrameApply(args: BrowserFrameApplyArgs) {
  const {
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
  } = args
  const applyFrame = useCallback((frame: BrowserScreencastFrame, frameCacheKey: string): void => {
    if (!browserFrameMetadataEqual(frameMetadataRef.current, frame.metadata)) {
      frameMetadataRef.current = frame.metadata
      setFrameMetadata(frame.metadata)
    }
    const nextFrameUri = createBrowserFrameDataUri(frame)
    cacheBrowserFrame(frameCacheKey, { uri: nextFrameUri, metadata: frame.metadata })
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
    } else {
      // Why: popovers/menus can settle in one final frame while the previous
      // offscreen frame is still decoding. Keep the hidden layer pointed at
      // the newest frame instead of dropping the final static state.
      frameUriRef.current = nextFrameUri
      updateBrowserImageSource(browserImageRefs.current[pendingFrameLayerRef.current], nextFrameUri)
    }
    if (busyRef.current) {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const clearFrameThrottle = useCallback(() => {
    pendingThrottledFrameRef.current = null
    if (frameThrottleTimerRef.current) {
      clearTimeout(frameThrottleTimerRef.current)
      frameThrottleTimerRef.current = null
    }
  }, [])

  const applyFrameThrottled = useCallback(
    (frame: BrowserScreencastFrame, frameCacheKey: string): void => {
      const now = Date.now()
      const elapsed = now - lastAppliedFrameAtRef.current
      if (lastAppliedFrameAtRef.current === 0 || elapsed >= MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS) {
        clearFrameThrottle()
        lastAppliedFrameAtRef.current = now
        applyFrame(frame, frameCacheKey)
        return
      }

      // Why: static UI changes can be the last frame Chromium emits. Coalesce
      // throttled frames so the final visible state is applied after the delay.
      pendingThrottledFrameRef.current = { frame, cacheKey: frameCacheKey }
      if (frameThrottleTimerRef.current) {
        return
      }
      frameThrottleTimerRef.current = setTimeout(
        () => {
          frameThrottleTimerRef.current = null
          const pending = pendingThrottledFrameRef.current
          pendingThrottledFrameRef.current = null
          if (!pending) {
            return
          }
          lastAppliedFrameAtRef.current = Date.now()
          applyFrame(pending.frame, pending.cacheKey)
        },
        Math.max(0, MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS - elapsed)
      )
    },
    [applyFrame, clearFrameThrottle]
  )
  return { applyFrameThrottled, clearFrameThrottle }
}
