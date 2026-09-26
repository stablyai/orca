import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { TerminalOscLinkRange } from '../../../src/shared/terminal-osc-link-ranges'
import { createTerminalCellMetricsStore } from './terminal-cell-metrics'
import type { TerminalWebViewHandle, TerminalWebViewProps } from './terminal-webview-contract'
import { useTerminalWebViewEngineErrorState } from './terminal-webview-engine-error-state'
import { useTerminalWebReadyWatchdog } from './terminal-webview-ready-watchdog'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { createTerminalWebViewPendingMessages } from './terminal-webview-pending-messages'
import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'
import { routeTerminalQueryReply } from './terminal-webview-query-reply-routing'
import { useTerminalWebViewReadyPromises } from './terminal-webview-ready-promises'
import { createTerminalWriteCoalescer } from './terminal-write-coalescer'

/**
 * Everything `TerminalWebView` does that is not about `react-native-webview`.
 *
 * The document is the same program on both platforms — inside the WebView it is the generated
 * script, on the page it is the modules that script is generated from — so the readiness
 * handshake, the pending queue, the write coalescer, the ready and measure promises and the whole
 * imperative handle are the same too. What differs is only how a command reaches the document and
 * how a notify comes back: a `postMessage` across the WebView bridge, or a direct call.
 *
 * So that difference is the two arguments, and both components are the small part that is left.
 * Writing the page's half as a second copy of this would be the fork the series exists to avoid:
 * the handle is the contract every consumer above it holds, and two implementations of it drift.
 */

export type TerminalWebViewTransport = {
  /** Hands one command, with its id already assigned, to the document. */
  post: (command: TerminalWebViewCommand & { id: number }) => void
  /**
   * Whether returning to the foreground has to re-prove the document is alive.
   *
   * iOS can keep the native view while discarding the WebView's JS state, so the native side
   * pings and replays nothing until that exact document answers. The page has no second content
   * process to lose: its document is the page's own modules, and if they were gone so was the
   * component holding this handle.
   *
   * Asked at the moment of recovery rather than at render, because the platform the native
   * component reads is the running one and a handle built once must not cache it.
   */
  pingsOnForegroundRecovery: () => boolean
}

export function useTerminalWebViewController(
  props: TerminalWebViewProps,
  transport: TerminalWebViewTransport
) {
  const {
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
    onCellBoxChange
  } = props
  const { pingsOnForegroundRecovery, post } = transport
  const isWebReadyRef = useRef(false)
  const pendingMessages = useMemo(() => createTerminalWebViewPendingMessages(), [])
  const messageIdRef = useRef(0)
  const pendingPingIdRef = useRef<number | null>(null)
  const terminalThemeKey = useMemo(() => JSON.stringify(terminalTheme ?? null), [terminalTheme])
  // Why: each init() call posts 'init' to the document and arms a fresh ready promise. The
  // document's init() rAF chain ends with a 'ready' notify that resolves it. measureFitDimensions
  // awaits this so it doesn't race ahead of term.open() / renderService population.
  const promises = useTerminalWebViewReadyPromises()
  const cellMetrics = useMemo(() => createTerminalCellMetricsStore(), [])
  const { clearEngineError, engineError, reportEngineError, reportNativeEngineError } =
    useTerminalWebViewEngineErrorState(onEngineError)
  const { armWebReadyWatchdog, clearWebReadyWatchdog } = useTerminalWebReadyWatchdog(
    isWebReadyRef,
    reportEngineError
  )

  const sendToDocument = useCallback(
    (msg: TerminalWebViewCommand) => {
      messageIdRef.current += 1
      const id = messageIdRef.current
      post({ ...msg, id })
      return id
    },
    [post]
  )

  const flushPendingMessages = useCallback(() => {
    pendingMessages.flush(sendToDocument)
  }, [pendingMessages, sendToDocument])

  const postMessage = useCallback(
    (msg: TerminalWebViewCommand) => {
      if (!isWebReadyRef.current) {
        pendingMessages.queue(msg)
        return
      }
      sendToDocument(msg)
    },
    [pendingMessages, sendToDocument]
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
      sendToDocument({ type: 'set-theme', terminalTheme })
      flushPendingMessages()
    },
    [
      clearEngineError,
      clearWebReadyWatchdog,
      flushPendingMessages,
      onWebReady,
      sendToDocument,
      terminalTheme
    ]
  )

  /** One notify from the document, already parsed. */
  const receive = useCallback(
    (msg: Record<string, unknown>) => {
      routeTerminalQueryReply(msg, onTerminalQueryReply)

      if (msg.type === 'web-ready') {
        cellMetrics.acceptWebReady(msg)
        confirmWebReady(true)
      } else if (
        msg.type === 'pong' &&
        typeof msg.pingId === 'number' &&
        msg.pingId === pendingPingIdRef.current
      ) {
        confirmWebReady(false)
      } else if (msg.type === 'ready') {
        // Why: the document's init() rAF chain has run — term is open, renderService is
        // populated, first paint has happened. Resolve any pending awaitReady() so a queued
        // measure can now safely read cell dims.
        promises.resolveReady()
      } else if (msg.type === 'cell-metrics') {
        const corrected = cellMetrics.acceptLaidOut(msg)
        if (
          corrected?.fontScale === textScale &&
          typeof msg.cols === 'number' &&
          typeof msg.rows === 'number'
        ) {
          onCellBoxChange?.({ cols: msg.cols, rows: msg.rows })
        }
      } else if (msg.type === 'measure-result') {
        promises.resolveMeasure(msg)
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
          onTextScaleChange
        })
      }
    },
    [
      cellMetrics,
      confirmWebReady,
      promises,
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
      onCellBoxChange,
      textScale
    ]
  )

  /**
   * The document is gone or about to be replaced: nothing queued belongs to the next one.
   *
   * Why: messages queued for a previous generation are stale after a reload; dropping them avoids
   * replaying terminal chunks before the next init snapshot.
   */
  const resetReadiness = useCallback(() => {
    isWebReadyRef.current = false
    pendingPingIdRef.current = null
    cellMetrics.clear()
    pendingMessages.clear()
    writeCoalescer.clear()
    armWebReadyWatchdog()
  }, [armWebReadyWatchdog, cellMetrics, pendingMessages, writeCoalescer])

  useEffect(() => {
    postMessage({ type: 'set-theme', terminalTheme })
  }, [postMessage, terminalThemeKey, terminalTheme])

  // Why: live-apply text-size changes to an already-mounted terminal (the pane
  // stays alive while the user visits Settings), so no terminal reload is needed.
  useEffect(() => {
    postMessage({ type: 'set-font-scale', fontScale: textScale })
  }, [postMessage, textScale])

  const handle = useMemo<TerminalWebViewHandle>(
    () => ({
      prepareForForegroundRecovery() {
        if (!pingsOnForegroundRecovery()) {
          return
        }
        // Why: direct ping is the only command allowed through while readiness is
        // invalid; init/write commands queue until this exact document answers.
        isWebReadyRef.current = false
        armWebReadyWatchdog()
        pendingPingIdRef.current = sendToDocument({ type: 'ping' })
      },
      write(data: string) {
        writeCoalescer.write(data)
      },
      init(
        cols: number,
        rows: number,
        initialData?: string,
        preserveScroll?: boolean,
        oscLinks?: TerminalOscLinkRange[]
      ) {
        // Why: arm a fresh ready promise BEFORE posting init. The document resolves it via the
        // 'ready' notify at the end of its rAF chain.
        promises.armReady()
        // Why: pending chunks are pre-snapshot data; the init snapshot supersedes
        // them, and writing them after init would corrupt the fresh buffer.
        writeCoalescer.clear()
        postMessage({
          type: 'init',
          cols,
          rows,
          initialData,
          oscLinks,
          terminalTheme,
          fontScale: textScale,
          preserveScroll
        })
      },
      resize(cols: number, rows: number) {
        // Why: resize/reflow must observe all prior writes or bytes reorder.
        writeCoalescer.flushNow()
        postMessage({ type: 'resize', cols, rows })
      },
      reflow(cols: number, rows: number) {
        writeCoalescer.flushNow()
        postMessage({ type: 'reflow', cols, rows })
      },
      clear() {
        writeCoalescer.clear()
        postMessage({ type: 'clear' })
      },
      fitDimensions(containerHeight?: number) {
        return cellMetrics.fit(textScale, containerHeight) ?? null
      },
      measureFitDimensions(containerHeight?: number) {
        if (!isWebReadyRef.current) {
          return Promise.resolve(null)
        }
        const fitted = cellMetrics.fit(textScale, containerHeight)
        if (fitted !== undefined) {
          return Promise.resolve(fitted)
        }
        return promises.measure(sendToDocument, containerHeight)
      },
      resetZoom() {
        postMessage({ type: 'reset-zoom' })
      },
      cancelSelect() {
        postMessage({ type: 'cancel-select' })
      },
      doSelectAll() {
        postMessage({ type: 'do-select-all' })
      },
      // Why: waits on the in-flight ready promise (set by init); resolves immediately if no init
      // is pending, and is capped so a stuck document doesn't hang the caller.
      awaitReady: promises.awaitReady
    }),
    [
      armWebReadyWatchdog,
      cellMetrics,
      pingsOnForegroundRecovery,
      postMessage,
      promises,
      sendToDocument,
      terminalTheme,
      textScale,
      writeCoalescer
    ]
  )

  return {
    armWebReadyWatchdog,
    /** The terminal view's RN layout; the document's own box stands in until it arrives. */
    layout: cellMetrics.layout,
    clearEngineError,
    confirmWebReady,
    engineError,
    handle,
    receive,
    reportNativeEngineError,
    resetReadiness
  }
}
