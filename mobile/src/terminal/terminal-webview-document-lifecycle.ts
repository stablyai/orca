import { useCallback, useRef, useState, type RefObject } from 'react'
import type { WebView } from 'react-native-webview'
import {
  TERMINAL_PAINT_READY_UNMET,
  useTerminalPaintReadyWatchdog
} from './terminal-webview-ready-watchdog'

type TerminalWebViewDocumentLifecycleOptions = {
  armWebReadyWatchdog: () => void
  attemptPingRecovery: (
    notifyParent: boolean,
    onGiveUp: () => void,
    isRecoveredRef?: RefObject<boolean>
  ) => void
  clearEngineError: () => void
  isWebReadyRef: RefObject<boolean>
  pendingMessages: { clear: () => void }
  pendingPingIdRef: RefObject<number | null>
  reportEngineError: (message: string, fatal: boolean) => void
  webViewRef: RefObject<WebView | null>
  writeCoalescer: { clear: () => void }
}

// Why: the document a WebView is showing can be replaced (reload), die (content-process
// loss), or come back blanked from an iOS suspend. Each of those invalidates readiness,
// the queued commands, and the painted surface at once, so they live together here —
// a path that resets only some of it is how a blank surface reaches the user (#17304).
export function useTerminalWebViewDocumentLifecycle({
  armWebReadyWatchdog,
  attemptPingRecovery,
  clearEngineError,
  isWebReadyRef,
  pendingMessages,
  pendingPingIdRef,
  reportEngineError,
  webViewRef,
  writeCoalescer
}: TerminalWebViewDocumentLifecycleOptions) {
  // Why: the engine's inline script blocks the document's first paint, and iOS can resume
  // with a blanked backing store — both show the native white surface. Track paint readiness
  // as state so the WebView stays hidden behind the themed container until init's 'ready',
  // which follows the post-init rAF chain and thus a committed paint.
  const [surfaceReady, setSurfaceReady] = useState(false)
  // Why: the watchdog fires from a timer, where React state is a stale closure.
  const surfacePaintedRef = useRef(false)

  const probeBeforePaintError = useCallback(() => {
    // Why: notifyParent, because the cure is a resubscribe whose re-init repaints — the
    // pong alone cannot reveal a surface that only init's 'ready' opens.
    attemptPingRecovery(
      true,
      () => reportEngineError(TERMINAL_PAINT_READY_UNMET, true),
      surfacePaintedRef
    )
  }, [attemptPingRecovery, reportEngineError])
  const { armPaintReadyWatchdog, clearPaintReadyWatchdog } = useTerminalPaintReadyWatchdog(
    surfacePaintedRef,
    reportEngineError,
    probeBeforePaintError
  )

  const markSurfacePainted = useCallback(() => {
    surfacePaintedRef.current = true
    setSurfaceReady(true)
    clearPaintReadyWatchdog()
  }, [clearPaintReadyWatchdog])
  const hideSurface = useCallback(() => {
    surfacePaintedRef.current = false
    setSurfaceReady(false)
  }, [])

  const invalidateDocument = useCallback(() => {
    isWebReadyRef.current = false
    surfacePaintedRef.current = false
    setSurfaceReady(false)
    pendingPingIdRef.current = null
    armWebReadyWatchdog()
    // Why: no init is outstanding against a document that is going away; the next one
    // arms a fresh paint watchdog.
    clearPaintReadyWatchdog()
    // Why: messages queued for a previous WebView generation are stale after a reload;
    // dropping them avoids replaying terminal chunks before the next init snapshot.
    pendingMessages.clear()
    writeCoalescer.clear()
  }, [
    armWebReadyWatchdog,
    clearPaintReadyWatchdog,
    isWebReadyRef,
    pendingMessages,
    pendingPingIdRef,
    writeCoalescer
  ])

  const reloadDocument = useCallback(() => {
    // Why: reload discards the backing store before onLoadStart can invalidate.
    invalidateDocument()
    webViewRef.current?.reload()
  }, [invalidateDocument, webViewRef])

  const handleReload = useCallback(() => {
    clearEngineError()
    // Why: in the wedged live-document state, reload reproduces the same error while a
    // ping recovers instantly (the app-switch cure); reload stays as the last resort.
    attemptPingRecovery(true, reloadDocument)
  }, [attemptPingRecovery, clearEngineError, reloadDocument])

  const handleContentProcessDidTerminate = useCallback(() => {
    // Why: WKWebView content-process loss is recoverable; stale commands belong
    // to the dead document and the replacement must prove readiness before replay.
    clearEngineError()
    reloadDocument()
  }, [clearEngineError, reloadDocument])

  return {
    armPaintReadyWatchdog,
    handleContentProcessDidTerminate,
    handleReload,
    hideSurface,
    invalidateDocument,
    markSurfacePainted,
    surfaceReady
  }
}
