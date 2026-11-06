import { useCallback, useEffect, useMemo, useRef } from 'react'
import { readTerminalCellBox, type TerminalCellBox } from './terminal-cell-box'
import type { TerminalWebViewProps } from './terminal-webview-contract'
import { useTerminalWebViewEngineErrorState } from './terminal-webview-engine-error-state'
import { useTerminalWebViewHandle } from './use-terminal-webview-handle'
import { useTerminalWebReadyWatchdog } from './terminal-webview-ready-watchdog'
import type { TerminalWebViewCommand } from './terminal-webview-messages'
import { createTerminalWebViewPendingMessages } from './terminal-webview-pending-messages'
import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'
import { routeTerminalQueryReply } from './terminal-webview-query-reply-routing'
import { useTerminalWebViewReadyPromises } from './terminal-webview-ready-promises'
import { createTerminalWriteCoalescer } from './terminal-write-coalescer'
import { isTerminalGestureInput } from './terminal-gesture-input'

// Share readiness, queues, coalescing and imperative handles across hosts; only document command/notify transport differs.

export type TerminalWebViewTransport = {
  post: (command: TerminalWebViewCommand & { id: number }) => void
  // Native recovery must ping the exact retained document because iOS can lose its JS state; embedded pages have no separate process.
  pingsOnForegroundRecovery: () => boolean
  // False for an in-process document: no bridge hop to batch writes for.
  coalesce?: boolean
}

export function useTerminalWebViewController(
  props: TerminalWebViewProps,
  transport: TerminalWebViewTransport
) {
  const {
    terminalTheme,
    interactionActive = true,
    tripleTapEnterEnabled = true,
    textScale = 1,
    onWebReady,
    onEngineError,
    onSelectionMode,
    onSelectionCopy,
    onSelectionEvicted,
    onClipboardWrite,
    onModesChanged,
    onKeyboardAvoidanceMetrics,
    onHaptic,
    onTerminalInput,
    onTerminalQueryReply,
    onTerminalInteraction,
    onTerminalTap,
    onTerminalTripleTap,
    onFileTap,
    onOpenUrl,
    onTextScaleChange,
    onCellBoxChange
  } = props
  const { coalesce, pingsOnForegroundRecovery, post } = transport
  const isWebReadyRef = useRef(false)
  const sentTripleTapEnterRef = useRef<boolean>(true)
  const pendingMessages = useMemo(() => createTerminalWebViewPendingMessages(), [])
  const messageIdRef = useRef(0)
  const pendingPingIdRef = useRef<number | null>(null)
  const terminalThemeKey = useMemo(() => JSON.stringify(terminalTheme ?? null), [terminalTheme])
  // Await init’s ready after its render chain so follow-up fit uses its measured cell box.
  const promises = useTerminalWebViewReadyPromises()
  const cellBoxRef = useRef<TerminalCellBox | null>(null)
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

  // Native coalesces busy PTY output to avoid paying bridge/IPC/paint overhead for every stream frame.
  const writeCoalescer = useMemo(
    () =>
      createTerminalWriteCoalescer((data) => postMessage({ type: 'write', data }), { coalesce }),
    [coalesce, postMessage]
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
      // Reload drops commands; readiness must restore the selected theme even if its React value did not change.
      sendToDocument({ type: 'set-interaction-active', active: interactionActive })
      if (!tripleTapEnterEnabled) {
        sendToDocument({ type: 'set-triple-tap-enter', enabled: false })
        sentTripleTapEnterRef.current = false
      } else {
        sentTripleTapEnterRef.current = true
      }
      sendToDocument({ type: 'set-theme', terminalTheme })
      flushPendingMessages()
    },
    [
      interactionActive,
      tripleTapEnterEnabled,
      clearEngineError,
      clearWebReadyWatchdog,
      flushPendingMessages,
      onWebReady,
      sendToDocument,
      terminalTheme
    ]
  )

  useEffect(() => {
    if (isWebReadyRef.current) {
      sendToDocument({ type: 'set-interaction-active', active: interactionActive })
    }
  }, [sendToDocument, interactionActive])

  useEffect(() => {
    if (isWebReadyRef.current && sentTripleTapEnterRef.current !== tripleTapEnterEnabled) {
      sentTripleTapEnterRef.current = tripleTapEnterEnabled
      sendToDocument({ type: 'set-triple-tap-enter', enabled: tripleTapEnterEnabled })
    }
  }, [sendToDocument, tripleTapEnterEnabled])

  const receive = useCallback(
    (msg: Record<string, unknown>) => {
      routeTerminalQueryReply(msg, onTerminalQueryReply)
      if (
        interactionActive &&
        msg.type === 'terminal-input' &&
        typeof msg.bytes === 'string' &&
        isTerminalGestureInput(msg.bytes)
      ) {
        writeCoalescer.markInteractive()
      }

      if (msg.type === 'web-ready') {
        cellBoxRef.current = readTerminalCellBox(msg)
        confirmWebReady(true)
      } else if (
        msg.type === 'pong' &&
        typeof msg.pingId === 'number' &&
        msg.pingId === pendingPingIdRef.current
      ) {
        confirmWebReady(false)
      } else if (msg.type === 'ready') {
        promises.resolveReady()
      } else if (msg.type === 'cell-box') {
        cellBoxRef.current = readTerminalCellBox(msg)
        if (msg.refit === true) {
          onCellBoxChange?.()
        }
      } else {
        dispatchTerminalWebViewNotification(msg, {
          reportEngineError,
          onSelectionMode,
          onSelectionCopy,
          onSelectionEvicted,
          onClipboardWrite,
          onModesChanged,
          onKeyboardAvoidanceMetrics,
          onHaptic,
          onTerminalInput: interactionActive ? onTerminalInput : undefined,
          onTerminalInteraction: interactionActive ? onTerminalInteraction : undefined,
          onTerminalTap: interactionActive ? onTerminalTap : undefined,
          onTerminalTripleTap: interactionActive ? onTerminalTripleTap : undefined,
          onFileTap: interactionActive ? onFileTap : undefined,
          onOpenUrl: interactionActive ? onOpenUrl : undefined,
          onTextScaleChange
        })
      }
    },
    [
      confirmWebReady,
      interactionActive,
      promises,
      reportEngineError,
      onSelectionMode,
      onSelectionCopy,
      onSelectionEvicted,
      onClipboardWrite,
      onModesChanged,
      onKeyboardAvoidanceMetrics,
      onHaptic,
      onTerminalInput,
      onTerminalQueryReply,
      onTerminalInteraction,
      onTerminalTap,
      onTerminalTripleTap,
      onFileTap,
      onOpenUrl,
      onTextScaleChange,
      onCellBoxChange,
      writeCoalescer
    ]
  )

  // Drop the old generation’s queue; its pre-snapshot chunks would corrupt the replacement buffer.
  const resetReadiness = useCallback(() => {
    isWebReadyRef.current = false
    pendingPingIdRef.current = null
    pendingMessages.clear()
    writeCoalescer.clear()
    cellBoxRef.current = null
    armWebReadyWatchdog()
  }, [armWebReadyWatchdog, pendingMessages, writeCoalescer])

  useEffect(() => {
    postMessage({ type: 'set-theme', terminalTheme })
  }, [postMessage, terminalThemeKey, terminalTheme])

  useEffect(() => {
    postMessage({ type: 'set-font-scale', fontScale: textScale })
  }, [postMessage, textScale])

  const handle = useTerminalWebViewHandle({
    armWebReadyWatchdog,
    cellBoxRef,
    isWebReadyRef,
    pendingPingIdRef,
    pingsOnForegroundRecovery,
    postMessage,
    promises,
    sendToDocument,
    terminalTheme,
    textScale,
    writeCoalescer
  })

  return {
    armWebReadyWatchdog,
    clearEngineError,
    confirmWebReady,
    engineError,
    handle,
    receive,
    reportNativeEngineError,
    resetReadiness
  }
}
