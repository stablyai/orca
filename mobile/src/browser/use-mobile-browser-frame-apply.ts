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
  type FrameLayer
} from './mobile-browser-frame-state'
import { createBrowserFrameDataUri } from './browser-frame-data-uri'
import { updateBrowserImageSource, whenBrowserFrameDisplayable } from './browser-frame-layer-paint'
import {
  abandonBrowserFrameLayer,
  settleBrowserFrameLayer,
  type BrowserFrameLayerRefs
} from './browser-frame-layer-flip'

type PendingFrame = { frame: BrowserScreencastFrame; cacheKey: string }
type BrowserFrameApplyArgs = BrowserFrameLayerRefs & {
  browserImageRefs: { current: [Image | null, Image | null] }
  busyRef: { current: boolean }
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  frameMountedRef: { current: boolean }
  frameThrottleTimerRef: { current: ReturnType<typeof setTimeout> | null }
  frameUriRef: { current: string | null }
  lastAppliedFrameAtRef: { current: number }
  pendingThrottledFrameRef: { current: PendingFrame | null }
  setBusy: Dispatch<SetStateAction<boolean>>
  setFrameMetadata: Dispatch<SetStateAction<BrowserScreencastFrameMetadata | null>>
  setFrameUri: Dispatch<SetStateAction<string | null>>
}
export function useMobileBrowserFrameApply(args: BrowserFrameApplyArgs) {
  const {
    browserImageRefs,
    browserLayerRefs,
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
  // Why: a `background-image` write fires no load event, so on the web the layer the frame landed
  // on has to be told when it has decoded. Native answers through the `<Image>`'s own `onLoad`,
  // and this is a no-op there.
  const armFrameLayerFlip = useCallback((layer: FrameLayer, uri: string): void => {
    const layerRefs = { browserLayerRefs, pendingFrameLayerRef, visibleFrameLayerRef }
    // Both arms answer for the frame they were armed with, not for the layer. A newer frame may
    // have been pointed at the same layer while this one decoded: flipping then would show a frame
    // the browser has not painted, and freeing the slot then would leave the newest frame's own
    // decode with nothing to flip and the pane stuck on an older frame.
    const isCurrentFrame = (): boolean => frameUriRef.current === uri
    whenBrowserFrameDisplayable(uri, {
      onDisplayable: () => {
        if (isCurrentFrame()) {
          settleBrowserFrameLayer(layerRefs, layer)
        }
      },
      onUndecodable: () => {
        if (isCurrentFrame()) {
          abandonBrowserFrameLayer(layerRefs, layer)
        }
      }
    })
  }, [])

  const applyFrame = useCallback(
    (frame: BrowserScreencastFrame, frameCacheKey: string): void => {
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
        armFrameLayerFlip(nextLayer, nextFrameUri)
      } else {
        // Why: popovers/menus can settle in one final frame while the previous
        // offscreen frame is still decoding. Keep the hidden layer pointed at
        // the newest frame instead of dropping the final static state.
        const pendingLayer = pendingFrameLayerRef.current
        frameUriRef.current = nextFrameUri
        updateBrowserImageSource(browserImageRefs.current[pendingLayer], nextFrameUri)
        armFrameLayerFlip(pendingLayer, nextFrameUri)
      }
      if (busyRef.current) {
        busyRef.current = false
        setBusy(false)
      }
    },
    [armFrameLayerFlip]
  )

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
