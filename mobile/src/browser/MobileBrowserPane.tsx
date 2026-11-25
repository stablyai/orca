/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: mobile browser state mirrors a remote desktop screencast session and CDP dialogs, which are external systems that cannot be derived during render. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AppState, type HostInstance } from 'react-native'
import type { MobileBrowserTab } from '../session/tabs/mobile-session-tabs'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BrowserScreencastFrameMetadata } from './screencast/browser-screencast-protocol'
import type { MobileBrowserViewMode } from './screencast/browser-screencast-request-parameters'
import {
  getInitialMobileBrowserViewMode,
  saveMobileBrowserViewMode
} from './pane-view/mobile-browser-view-mode-state'
import type {
  BrowserTouchLayout,
  BrowserZoomState
} from './page-interaction/browser-touch-geometry'
import {
  clearCachedBrowserFramesForWorktree,
  makeBrowserFrameCacheKey,
  peekCachedBrowserFrame,
  type PinchGesture
} from './screencast/mobile-browser-frame-state'
import { displayBrowserUrl, normalizeBrowserUrl } from './pane-view/browser-url'
import { useMobileBrowserCertificateProceed } from './certificate/mobile-browser-certificate-proceed'
import type { BrowserDialogState } from './screencast/mobile-browser-stream-events'
import {
  browserGoBack,
  browserGoForward,
  browserNavigate,
  browserReload,
  browserStop
} from './page-interaction/mobile-browser-command-operations'
import { resolveMobileBrowserAddressSync } from './pane-view/mobile-browser-address-sync'
import { MobileBrowserPaneView } from './pane-view/MobileBrowserPaneView'
import { useMobileBrowserInteractions } from './page-interaction/use-mobile-browser-interactions'
import type { BrowserPageCommandSend } from './page-interaction/use-mobile-browser-request'
import { useMobileBrowserStream } from './screencast/use-mobile-browser-stream'
import { useMobileBrowserPagePrompts } from './page-interaction/use-mobile-browser-page-prompts'
import { useBrowserBinaryScreencastGrant } from './screencast/use-browser-binary-screencast-grant'
import type { MobileBrowserHostSupport } from './mobile-browser-host-support'
import { useRouteRelaysCapability } from '../worktree/execution-hosts/workspace-server-context'
import {
  BROWSER_MOBILE_STOP_RUNTIME_CAPABILITY,
  BROWSER_PAGE_PROMPTS_RUNTIME_CAPABILITY
} from '../../../src/shared/browser/runtime/browser-runtime-capabilities'

type MobileBrowserPaneProps = {
  client: RpcClient | null
  worktreeId: string
  tab: MobileBrowserTab
  screencastSupported: boolean | null
  hostSupport: MobileBrowserHostSupport
  keyboardLift: number
  bottomInset: number
  onToast: (message: string, durationMs?: number) => void
  bare?: boolean
  pageOverlay?: ReactNode
}

type PanGesture = {
  x: number
  y: number
  offsetX: number
  offsetY: number
}

const DEFAULT_ZOOM: BrowserZoomState = { scale: 1, offsetX: 0, offsetY: 0 }

export function MobileBrowserPane({
  client,
  worktreeId,
  tab,
  screencastSupported,
  hostSupport,
  keyboardLift,
  bottomInset,
  onToast,
  bare,
  pageOverlay
}: MobileBrowserPaneProps) {
  useMobileTranslation()
  const [browserViewMode, setBrowserViewMode] = useState<MobileBrowserViewMode>(() =>
    getInitialMobileBrowserViewMode(worktreeId, tab.browserPageId, tab.url)
  )
  const cacheKey = makeBrowserFrameCacheKey(worktreeId, tab.browserPageId, browserViewMode)
  const cachedInitialFrame = peekCachedBrowserFrame(cacheKey)
  const [addressValue, setAddressValue] = useState(displayBrowserUrl(tab.url))
  const [addressFocused, setAddressFocused] = useState(false)
  const [addressSyncState, setAddressSyncState] = useState({
    focused: false,
    url: tab.url
  })
  const [frameMetadata, setFrameMetadata] = useState<BrowserScreencastFrameMetadata | null>(
    cachedInitialFrame?.metadata ?? null
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<BrowserDialogState | null>(null)
  const pagePrompts = useMobileBrowserPagePrompts({ client, onToast })
  const relaysPagePrompts = useRouteRelaysCapability(BROWSER_PAGE_PROMPTS_RUNTIME_CAPABILITY)
  const [zoom, setZoom] = useState<BrowserZoomState>(DEFAULT_ZOOM)
  const [layout, setLayout] = useState<BrowserTouchLayout | null>(null)
  // Why: a new id per return, so a leave and return that React batches into one render still restart the stream.
  const [foregroundVisit, setForegroundVisit] = useState<number | null>(
    AppState.currentState === 'active' ? 0 : null
  )
  const foregroundVisitCountRef = useRef(0)
  const streamGenerationRef = useRef(0)
  const layoutRef = useRef<BrowserTouchLayout | null>(null)
  const frameMetadataRef = useRef<BrowserScreencastFrameMetadata | null>(
    cachedInitialFrame?.metadata ?? null
  )
  const busyRef = useRef(false)
  const pageCoveredRef = useRef(false)
  const gestureCancelledRef = useRef(false)
  const lastStreamCacheKeyRef = useRef<string | null>(cacheKey)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startPointRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const scrollingRef = useRef(false)
  const zoomRef = useRef<BrowserZoomState>(DEFAULT_ZOOM)
  const pinchRef = useRef<PinchGesture | null>(null)
  const panRef = useRef<PanGesture | null>(null)
  const lastZoomResetUrlRef = useRef(tab.url || 'about:blank')

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const setRootViewRef = useCallback(
    (node: HostInstance | null) => {
      // Clear surface-owned long-press timers at ref cleanup to preserve unmount boundary.
      if (node === null) {
        clearLongPressTimer()
      }
    },
    [clearLongPressTimer]
  )

  const cancelPageGesture = useCallback(() => {
    clearLongPressTimer()
    pinchRef.current = null
    panRef.current = null
    scrollingRef.current = false
    startPointRef.current = null
  }, [clearLongPressTimer])

  const resetBrowserZoomState = useCallback(() => {
    cancelPageGesture()
    zoomRef.current = DEFAULT_ZOOM
    setZoom(DEFAULT_ZOOM)
  }, [cancelPageGesture])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') {
        clearCachedBrowserFramesForWorktree(worktreeId)
        setForegroundVisit(null)
        return
      }
      foregroundVisitCountRef.current += 1
      setForegroundVisit(foregroundVisitCountRef.current)
    })
    return () => {
      subscription.remove()
    }
  }, [worktreeId])

  const addressSync = resolveMobileBrowserAddressSync(addressSyncState, {
    focused: addressFocused,
    url: tab.url
  })
  if (addressSync.nextState !== addressSyncState) {
    setAddressSyncState(addressSync.nextState)
    if (addressSync.shouldSyncValue) {
      // Preserve stream/goto updates without stale post-blur paint when tab URL is authoritative.
      setAddressValue(displayBrowserUrl(tab.url))
    }
  }

  useLayoutEffect(() => {
    // Publish committed gesture/stream refs before passive effects without leaking uncommitted render values.
    frameMetadataRef.current = frameMetadata
    layoutRef.current = layout
    const pageCovered = dialog !== null || pagePrompts.prompt !== null
    // A touch already down when a card opens must not land its tap or long-press right-click under it.
    if (pageCovered && !pageCoveredRef.current) {
      cancelPageGesture()
      gestureCancelledRef.current = true
    }
    pageCoveredRef.current = pageCovered
    zoomRef.current = zoom
  }, [cancelPageGesture, dialog, frameMetadata, layout, pagePrompts.prompt, zoom])

  useEffect(() => {
    lastZoomResetUrlRef.current = tab.url || 'about:blank'
    resetBrowserZoomState()
  }, [resetBrowserZoomState, tab.browserPageId, tab.url])

  useEffect(() => {
    setBrowserViewMode(getInitialMobileBrowserViewMode(worktreeId, tab.browserPageId, tab.url))
  }, [tab.browserPageId, tab.url, worktreeId])

  const binaryScreencastGranted = useBrowserBinaryScreencastGrant()

  const {
    frameGeometry,
    frameLayers,
    pageParams,
    reconnectStream,
    renderedFrameSource,
    sendBrowserRequest,
    streamStopped
  } = useMobileBrowserStream({
    binaryScreencastGranted,
    // A desktop relaying to a server must also forward the answers.
    pagePromptsSupported: hostSupport.pagePrompts && relaysPagePrompts,
    handlePageEvent: pagePrompts.handlePageEvent,
    clearPagePrompt: pagePrompts.clearPrompt,
    browserViewMode,
    busyRef,
    cacheKey,
    client,
    frameMetadata,
    frameMetadataRef,
    foregroundVisit,
    initialFrameUri: cachedInitialFrame?.uri ?? null,
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
  })

  const navigateTo = useCallback(
    async (url: string) => {
      const settled = await sendBrowserRequest(
        async (rpc, page, options) =>
          browserNavigate.interpret(await browserNavigate.request(rpc, { ...page, url }, options)),
        { showBusy: true, timeoutMs: 30_000 }
      )
      if (settled?.url !== undefined) {
        setAddressValue(displayBrowserUrl(settled.url))
        lastZoomResetUrlRef.current = settled.url
        resetBrowserZoomState()
      }
    },
    [resetBrowserZoomState, sendBrowserRequest]
  )

  const navigateToAddress = useCallback(async () => {
    const url = normalizeBrowserUrl(addressValue)
    if (!url) {
      setError(translate('browser.pane.invalidUrl', 'Enter a valid URL.'))
      return
    }
    await navigateTo(url)
  }, [addressValue, navigateTo])

  const { panResponder, pageInput, sendDialogCommand } = useMobileBrowserInteractions({
    clearLongPressTimer,
    client,
    pageCoveredRef,
    gestureCancelledRef,
    frameGeometry,
    frameMetadataRef,
    layoutRef,
    longPressTimerRef,
    onToast,
    pageParams,
    panRef,
    pinchRef,
    sendBrowserRequest,
    scrollingRef,
    startPointRef,
    setDialog,
    setError,
    setZoom,
    zoomRef
  })

  const controlsDisabled = !client || !tab.browserPageId || screencastSupported !== true
  // Waits for anything still being typed, so it lands on the page it was typed into.
  const runPageCommand = useCallback(
    (send: BrowserPageCommandSend) => {
      void pageInput.queue([{ run: () => sendBrowserRequest(send, { suppressError: true }) }])
    },
    [pageInput, sendBrowserRequest]
  )
  const goBack = useCallback(() => {
    if (controlsDisabled || !tab.canGoBack) {
      return
    }
    runPageCommand(async (rpc, page, options) =>
      browserGoBack.interpret(await browserGoBack.request(rpc, page, options))
    )
  }, [controlsDisabled, runPageCommand, tab.canGoBack])
  const goForward = useCallback(() => {
    if (controlsDisabled || !tab.canGoForward) {
      return
    }
    runPageCommand(async (rpc, page, options) =>
      browserGoForward.interpret(await browserGoForward.request(rpc, page, options))
    )
  }, [controlsDisabled, runPageCommand, tab.canGoForward])
  const reloadPage = useCallback(() => {
    if (controlsDisabled) {
      return
    }
    runPageCommand(async (rpc, page, options) =>
      browserReload.interpret(await browserReload.request(rpc, page, options))
    )
  }, [controlsDisabled, runPageCommand])
  // As on desktop, the reload button doubles as Stop while the page loads.
  // An older paired desktop relaying to a newer server refuses browser.stop from a phone.
  const stopRelayed = useRouteRelaysCapability(BROWSER_MOBILE_STOP_RUNTIME_CAPABILITY)
  const showStop = hostSupport.stop && stopRelayed && tab.loading
  const stopPage = useCallback(() => {
    if (controlsDisabled) {
      return
    }
    runPageCommand(async (rpc, page, options) =>
      browserStop.interpret(await browserStop.request(rpc, page, options))
    )
  }, [controlsDisabled, runPageCommand])

  // As on desktop's streamed pane: reloading the host's error page only refreshes it, so re-attempt the URL that failed.
  const retryFailedLoad = useCallback(() => {
    if (controlsDisabled) {
      return
    }
    void pageInput.queue([{ run: () => navigateTo(tab.loadError?.validatedUrl || tab.url) }])
  }, [controlsDisabled, navigateTo, pageInput, tab.loadError?.validatedUrl, tab.url])

  const proceedCertificate = useMobileBrowserCertificateProceed(
    client,
    worktreeId,
    tab.browserPageId
  )

  const selectBrowserViewMode = useCallback(
    (mode: MobileBrowserViewMode) => {
      if (browserViewMode === mode) {
        return
      }
      // Why: preserve explicit page-scoped choices across normal browser pane remounts.
      saveMobileBrowserViewMode(worktreeId, tab.browserPageId, mode)
      setBrowserViewMode(mode)
      resetBrowserZoomState()
    },
    [browserViewMode, resetBrowserZoomState, tab.browserPageId, worktreeId]
  )

  return (
    <MobileBrowserPaneView
      bare={bare}
      pageOverlay={pageOverlay}
      addressFocused={addressFocused}
      addressValue={addressValue}
      bottomInset={bottomInset}
      browserViewMode={browserViewMode}
      busy={busy}
      certificateTrustSupported={hostSupport.certificateTrust}
      controlsDisabled={controlsDisabled}
      dialog={dialog}
      pagePrompt={pagePrompts.prompt}
      answerPagePrompt={pagePrompts.answer}
      error={error}
      frameGeometry={frameGeometry}
      frameLayers={frameLayers}
      goBack={goBack}
      goForward={goForward}
      keyboardLift={keyboardLift}
      layoutRef={layoutRef}
      panResponder={panResponder}
      proceedCertificate={proceedCertificate}
      reconnectStream={reconnectStream}
      reloadPage={reloadPage}
      showStop={showStop}
      stopPage={stopPage}
      streamStopped={streamStopped}
      retryFailedLoad={retryFailedLoad}
      renderedFrameSource={renderedFrameSource}
      selectBrowserViewMode={selectBrowserViewMode}
      sendDialogCommand={sendDialogCommand}
      pageInput={pageInput}
      navigateToAddress={async () => {
        await pageInput.queue([{ run: navigateToAddress }])
      }}
      onToast={onToast}
      setAddressFocused={setAddressFocused}
      setAddressValue={setAddressValue}
      setLayout={setLayout}
      setRootViewRef={setRootViewRef}
      tab={tab}
      zoom={zoom}
    />
  )
}
