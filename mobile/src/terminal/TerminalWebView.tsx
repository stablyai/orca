import { useRef, useCallback, forwardRef, useImperativeHandle, useEffect, useMemo } from 'react'
import { View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { TerminalWebViewHandle, TerminalWebViewProps } from './terminal-webview-contract'
import {
  TerminalWebViewEngineErrorOverlay,
  useTerminalWebViewEngineErrorState
} from './terminal-webview-engine-error-state'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import { useTerminalWebReadyWatchdog } from './terminal-webview-ready-watchdog'
import { XTERM_WEBVIEW_SOURCE } from './terminal-webview-html'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { createTerminalWebViewPendingMessages } from './terminal-webview-pending-messages'
import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'
import { routeTerminalQueryReply } from './terminal-webview-query-reply-routing'
import { createTerminalWriteCoalescer } from './terminal-write-coalescer'
import { createTerminalWebViewHandle } from './terminal-webview-handle'

type Props = TerminalWebViewProps

export type { TerminalWebViewHandle } from './terminal-webview-contract'

export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(function TerminalWebView(
  {
    style,
    terminalTheme,
    textScale = 1,
    onWebReady,
    onEngineError,
    onSelectionMode,
    onSelectionCopy,
    onSelectionEvicted,
    onModesChanged,
    onKeyboardAvoidanceMetrics,
    onHaptic,
    onTerminalInput,
    onTerminalQueryReply,
    onTerminalTap,
    onFileTap,
    onOpenUrl,
    onTextScaleChange,
    onViewportChanged
  },
  ref
) {
  const webViewRef = useRef<WebView>(null)
  const isWebReadyRef = useRef(false)
  const pendingMessages = useMemo(() => createTerminalWebViewPendingMessages(), [])
  const messageIdRef = useRef(0)
  const pendingPingIdRef = useRef<number | null>(null)
  const terminalThemeKey = useMemo(() => JSON.stringify(terminalTheme ?? null), [terminalTheme])
  const measureResolveRef = useRef<
    ((result: { cols: number; rows: number } | null) => void) | null
  >(null)
  // Why: each init() call posts 'init' to the WebView and arms a fresh
  // ready promise. WebView's init() rAF chain ends with a 'ready' notify
  // that resolves it. measureFitDimensions awaits this so it doesn't
  // race ahead of term.open() / renderService population.
  const readyPromiseRef = useRef<Promise<void> | null>(null)
  const readyResolveRef = useRef<(() => void) | null>(null)
  const { clearEngineError, engineError, reportEngineError, reportNativeEngineError } =
    useTerminalWebViewEngineErrorState(onEngineError)
  const { armWebReadyWatchdog, clearWebReadyWatchdog } = useTerminalWebReadyWatchdog(
    isWebReadyRef,
    reportEngineError
  )

  const sendToWebView = useCallback((msg: TerminalWebViewCommand) => {
    messageIdRef.current += 1
    const id = messageIdRef.current
    webViewRef.current?.postMessage(JSON.stringify({ ...msg, id }))
    return id
  }, [])

  const flushPendingMessages = useCallback(() => {
    pendingMessages.flush(sendToWebView)
  }, [pendingMessages, sendToWebView])

  const postMessage = useCallback(
    (msg: TerminalWebViewCommand) => {
      if (!isWebReadyRef.current) {
        pendingMessages.queue(msg)
        return
      }
      sendToWebView(msg)
    },
    [pendingMessages, sendToWebView]
  )

  // Why: a busy PTY delivers ~200 stream frames/s; coalescing here collapses the
  // per-frame bridge + WebKit IPC + paint cost that runs the phone hot (#9302).
  const writeCoalescer = useMemo(
    () => createTerminalWriteCoalescer((data) => postMessage({ type: 'write', data })),
    [postMessage]
  )

  useEffect(() => {
    return () => {
      writeCoalescer.clear()
    }
  }, [writeCoalescer])

  const confirmWebReady = useCallback(
    (notifyParent: boolean) => {
      pendingPingIdRef.current = null
      isWebReadyRef.current = true
      clearWebReadyWatchdog()
      clearEngineError()
      if (notifyParent) {
        onWebReady?.()
      }
      // Why: reload clears queued commands, so readiness must always restore the
      // native-selected theme even when its value did not change in React.
      sendToWebView({ type: 'set-theme', terminalTheme })
      flushPendingMessages()
    },
    [
      clearEngineError,
      clearWebReadyWatchdog,
      flushPendingMessages,
      onWebReady,
      sendToWebView,
      terminalTheme
    ]
  )

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>
      } catch {
        return
      }
      routeTerminalQueryReply(msg, onTerminalQueryReply)

      if (msg.type === 'web-ready') {
        confirmWebReady(true)
      } else if (
        msg.type === 'pong' &&
        typeof msg.pingId === 'number' &&
        msg.pingId === pendingPingIdRef.current
      ) {
        confirmWebReady(false)
      } else if (msg.type === 'ready') {
        // Why: the WebView's init() rAF chain has run — term is open,
        // renderService is populated, first paint has happened. Resolve
        // any pending awaitReady() so a queued measure can now safely
        // read cell dims.
        const resolve = readyResolveRef.current
        readyResolveRef.current = null
        readyPromiseRef.current = null
        resolve?.()
      } else if (msg.type === 'measure-result') {
        const resolve = measureResolveRef.current
        measureResolveRef.current = null
        if (resolve) {
          const cols = typeof msg.cols === 'number' ? msg.cols : null
          const rows = typeof msg.rows === 'number' ? msg.rows : null
          resolve(cols && rows && cols >= 20 && rows >= 8 ? { cols, rows } : null)
        }
      } else {
        dispatchTerminalWebViewNotification(msg, {
          reportEngineError,
          onSelectionMode,
          onSelectionCopy,
          onSelectionEvicted,
          onModesChanged,
          onKeyboardAvoidanceMetrics,
          onHaptic,
          onTerminalInput,
          onTerminalTap,
          onFileTap,
          onOpenUrl,
          onTextScaleChange,
          onViewportChanged
        })
      }
    },
    [
      confirmWebReady,
      reportEngineError,
      onSelectionMode,
      onSelectionCopy,
      onSelectionEvicted,
      onModesChanged,
      onKeyboardAvoidanceMetrics,
      onHaptic,
      onTerminalInput,
      onTerminalQueryReply,
      onTerminalTap,
      onFileTap,
      onOpenUrl,
      onTextScaleChange,
      onViewportChanged
    ]
  )

  const handleLoadStart = useCallback(() => {
    isWebReadyRef.current = false
    pendingPingIdRef.current = null
    armWebReadyWatchdog()
    // Why: messages queued for a previous WebView generation are stale after a reload;
    // dropping them avoids replaying terminal chunks before the next init snapshot.
    pendingMessages.clear()
    writeCoalescer.clear()
  }, [armWebReadyWatchdog, pendingMessages, writeCoalescer])

  const handleReload = useCallback(() => {
    clearEngineError()
    webViewRef.current?.reload()
  }, [clearEngineError])

  const handleContentProcessDidTerminate = useCallback(() => {
    // Why: WKWebView content-process loss is recoverable; stale commands belong
    // to the dead document and the replacement must prove readiness before replay.
    isWebReadyRef.current = false
    pendingPingIdRef.current = null
    pendingMessages.clear()
    writeCoalescer.clear()
    clearEngineError()
    armWebReadyWatchdog()
    webViewRef.current?.reload()
  }, [armWebReadyWatchdog, clearEngineError, pendingMessages, writeCoalescer])

  useEffect(() => {
    postMessage({ type: 'set-theme', terminalTheme })
  }, [postMessage, terminalThemeKey, terminalTheme])

  // Why: live-apply text-size changes to an already-mounted terminal (the pane
  // stays alive while the user visits Settings), so no terminal reload is needed.
  useEffect(() => {
    postMessage({ type: 'set-font-scale', fontScale: textScale })
  }, [postMessage, textScale])

  useImperativeHandle(
    ref,
    () =>
      createTerminalWebViewHandle({
        armWebReadyWatchdog,
        isWebReadyRef,
        measureResolveRef,
        pendingPingIdRef,
        postMessage,
        readyPromiseRef,
        readyResolveRef,
        sendToWebView,
        terminalTheme,
        textScale,
        writeCoalescer
      }),
    [armWebReadyWatchdog, postMessage, sendToWebView, terminalTheme, textScale, writeCoalescer]
  )

  return (
    <View style={[TERMINAL_WEBVIEW_FRAME_STYLES.container, style]}>
      <WebView
        ref={webViewRef}
        source={XTERM_WEBVIEW_SOURCE}
        style={TERMINAL_WEBVIEW_FRAME_STYLES.webview}
        originWhitelist={['*']}
        javaScriptEnabled
        scrollEnabled={false}
        // Why: Android parent gesture containers can intercept vertical drags
        // before the injected xterm scroll router sees them.
        nestedScrollEnabled
        scalesPageToFit={false}
        // Why: Android WebView defaults textZoom to the system font scale, inflating
        // xterm's DOM glyphs past its canvas-measured cell grid (#4579). iOS ignores it.
        textZoom={100}
        onLoadStart={handleLoadStart}
        onMessage={handleMessage}
        onError={(event) => reportNativeEngineError('Terminal WebView load failed', event)}
        onHttpError={(event) => reportNativeEngineError('Terminal WebView HTTP error', event)}
        onRenderProcessGone={(event) =>
          reportNativeEngineError('Terminal WebView render process ended', event)
        }
        onContentProcessDidTerminate={handleContentProcessDidTerminate}
      />
      {engineError ? (
        <TerminalWebViewEngineErrorOverlay message={engineError} onReload={handleReload} />
      ) : null}
    </View>
  )
})
