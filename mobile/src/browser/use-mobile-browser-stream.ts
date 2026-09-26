import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { PixelRatio } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { BrowserScreencastFrameMetadata } from '../transport/browser-screencast-protocol'
import {
  buildMobileBrowserScreencastRequest,
  type MobileBrowserViewMode
} from './browser-screencast-request'
import {
  MAX_ZOOM,
  MIN_ZOOM,
  browserFrameMetadataEqual,
  cacheBrowserFrame,
  getCachedBrowserFrame
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
import { createBrowserFramePacer } from './browser-frame-pacer'
import { useMobileBrowserRequest } from './use-mobile-browser-request'

type MobileBrowserStreamArgs = {
  binaryScreencastGranted: boolean
  browserViewMode: MobileBrowserViewMode
  busyRef: { current: boolean }
  cacheKey: string | null
  client: RpcClient | null
  frameMetadata: BrowserScreencastFrameMetadata | null
  frameMetadataRef: { current: BrowserScreencastFrameMetadata | null }
  /** Null while the app is away; each return to the foreground is a new value. */
  foregroundVisit: number | null
  initialFrameUri: string | null
  lastStreamCacheKeyRef: { current: string | null }
  lastZoomResetUrlRef: { current: string }
  layout: BrowserTouchLayout | null
  resetBrowserZoomState: () => void
  screencastSupported: boolean | null
  setAddressValue: Dispatch<SetStateAction<string>>
  setBusy: Dispatch<SetStateAction<boolean>>
  setDialog: Dispatch<SetStateAction<BrowserDialogState | null>>
  setError: Dispatch<SetStateAction<string | null>>
  setFrameMetadata: Dispatch<SetStateAction<BrowserScreencastFrameMetadata | null>>
  setZoom: Dispatch<SetStateAction<BrowserZoomState>>
  streamGenerationRef: { current: number }
  tab: MobileBrowserTab
  worktreeId: string
  zoomRef: { current: BrowserZoomState }
}

export function useMobileBrowserStream(args: MobileBrowserStreamArgs) {
  const {
    binaryScreencastGranted,
    browserViewMode,
    busyRef,
    cacheKey,
    client,
    frameMetadata,
    frameMetadataRef,
    foregroundVisit,
    initialFrameUri,
    lastStreamCacheKeyRef,
    lastZoomResetUrlRef,
    layout,
    resetBrowserZoomState,
    screencastSupported,
    setAddressValue,
    setBusy,
    setDialog,
    setError,
    setFrameMetadata,
    setZoom,
    streamGenerationRef,
    tab,
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

  const [frameUri, setFrameUri] = useState(initialFrameUri)
  const [framePacer] = useState(() =>
    createBrowserFramePacer({
      initialUri: initialFrameUri,
      setFrameUri,
      // Why: at the flip, so touch mapping uses the geometry of the frame on screen.
      onShown: ({ frame, cacheKey: shownCacheKey, uri }) => {
        cacheBrowserFrame(shownCacheKey, { uri, metadata: frame.metadata })
        if (!browserFrameMetadataEqual(frameMetadataRef.current, frame.metadata)) {
          frameMetadataRef.current = frame.metadata
          setFrameMetadata(frame.metadata)
        }
        if (busyRef.current) {
          busyRef.current = false
          setBusy(false)
        }
      }
    })
  )

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
    if (sameStream && framePacer.hasFrame()) {
      framePacer.reset()
    } else {
      const cachedFrame = getCachedBrowserFrame(cacheKey)
      framePacer.replace(cachedFrame?.uri ?? null)
      frameMetadataRef.current = cachedFrame?.metadata ?? null
      setFrameMetadata(cachedFrame?.metadata ?? null)
    }
    setDialog(null)
    setError(null)
    if (
      !client ||
      !binaryScreencastGranted ||
      screencastSupported !== true ||
      !tab.browserPageId ||
      foregroundVisit === null ||
      !streamRequest
    ) {
      busyRef.current = false
      setBusy(false)
      if (!binaryScreencastGranted) {
        // Before the desktop's answer, because this one is about the app in the user's hand and no
        // desktop update can change it.
        setError('Update the Orca app to stream browser tabs here.')
      } else if (screencastSupported === false) {
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
            framePacer.push(frame, cacheKey)
          }
        }
      }
    )
    return () => {
      clearStartupTimer()
      framePacer.reset()
      unsubscribe()
    }
  }, [
    binaryScreencastGranted,
    client,
    foregroundVisit,
    framePacer,
    resetBrowserZoomState,
    screencastSupported,
    streamRequest,
    cacheKey,
    tab.browserPageId,
    worktreeId
  ])

  // Why: only mounts the layers; the pacer re-points them natively, which a re-render must not undo.
  const renderedFrameSource = frameUri ? { uri: frameUri } : null

  return {
    frameGeometry,
    frameLayers: framePacer.layers,
    pageParams,
    renderedFrameSource,
    sendBrowserRequest
  }
}
