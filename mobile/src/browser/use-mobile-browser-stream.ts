import { translate } from '../i18n/mobile-i18n'
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { PixelRatio } from 'react-native'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BrowserScreencastFrameMetadata } from './browser-screencast-protocol'
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
import type { MobileBrowserTab } from '../session/tabs/mobile-session-tabs'
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
      // Clamp pan after rotation/layout shrink so zoom state cannot retain invalid previous geometry.
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
        // Check app-local limitation before desktop reply; desktop updates cannot change phone build.
        setError(
          translate('browser.stream.updateApp', 'Update the Orca app to stream browser tabs here.')
        )
      } else if (screencastSupported === false) {
        setError(
          translate(
            'browser.stream.updateDesktop',
            'Update desktop Orca to stream browser tabs on mobile.'
          )
        )
      } else if (screencastSupported === null) {
        setError(
          translate('browser.stream.checking', 'Checking desktop browser streaming support.')
        )
      } else if (!tab.browserPageId) {
        setError(translate('browser.stream.pageUnavailable', 'Browser page is not available yet.'))
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
      setError(translate('browser.stream.timedOut', 'Browser stream timed out.'))
    }, 15_000)
    const clearStartupTimer = (): void => {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
    }
    const worktree = `id:${worktreeId}`
    // Set once `ready` echoes frameAck; hosts that strip the opt-in never get an ack.
    let ackSubscriptionId: string | null = null
    const unsubscribe = client.subscribe(
      'browser.screencast',
      {
        worktree,
        page: tab.browserPageId,
        ...streamRequest,
        frameAck: 1
      },
      (payload) => {
        if (streamGenerationRef.current !== generation) {
          return
        }
        const ready = readScreencastReady(payload)
        if (ready) {
          ackSubscriptionId = ready.frameAck === true ? ready.subscriptionId : null
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
          if (ackSubscriptionId) {
            // Cumulative, so a frame the shell dropped is covered by the next one's ack.
            void client
              .sendRequest('browser.screencast.ack', {
                worktree,
                subscriptionId: ackSubscriptionId,
                seq: frame.seq
              })
              .catch(() => {})
          }
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

function readScreencastReady(
  payload: unknown
): { subscriptionId: string; frameAck: unknown } | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('type' in payload) ||
    payload.type !== 'ready' ||
    !('subscriptionId' in payload) ||
    typeof payload.subscriptionId !== 'string'
  ) {
    return null
  }
  return {
    subscriptionId: payload.subscriptionId,
    frameAck: 'frameAck' in payload ? payload.frameAck : undefined
  }
}
