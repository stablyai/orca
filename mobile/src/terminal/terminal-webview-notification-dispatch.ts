import type { TerminalSelectionEvents } from './terminal-webview-contract'

export type TerminalWebViewNotificationHandlers = Omit<
  TerminalSelectionEvents,
  'onTerminalQueryReply'
> & {
  reportEngineError: (message: string, fatal: boolean) => void
}

// Fans WebView notification messages out to the RN prop callbacks. Readiness and
// measure replies stay in TerminalWebView because they mutate its refs.
export function dispatchTerminalWebViewNotification(
  msg: Record<string, unknown>,
  handlers: TerminalWebViewNotificationHandlers
) {
  if (msg.type === 'log') {
    // Surface fit-scale diagnostics in the RN/Metro console.
    const tag = typeof msg.tag === 'string' ? msg.tag : '[fit]'
    // eslint-disable-next-line no-console
    console.log(tag, msg.payload)
  } else if (msg.type === 'error') {
    const message = typeof msg.message === 'string' ? msg.message : 'Unknown terminal error'
    handlers.reportEngineError(message, msg.fatal !== false)
  } else if (msg.type === 'set-select-mode') {
    handlers.onSelectionMode?.(!!msg.enabled)
  } else if (msg.type === 'selection') {
    const text = typeof msg.text === 'string' ? msg.text : ''
    handlers.onSelectionCopy?.(text)
  } else if (msg.type === 'selection-evicted') {
    handlers.onSelectionEvicted?.()
  } else if (msg.type === 'modes') {
    const mouseTrackingMode =
      msg.mouseTrackingMode === 'x10' ||
      msg.mouseTrackingMode === 'vt200' ||
      msg.mouseTrackingMode === 'drag' ||
      msg.mouseTrackingMode === 'any'
        ? msg.mouseTrackingMode
        : 'none'
    handlers.onModesChanged?.({
      bracketedPasteMode: !!msg.bracketedPasteMode,
      altScreen: !!msg.altScreen,
      mouseTrackingMode,
      sgrMouseMode: !!msg.sgrMouseMode,
      sgrMousePixelsMode: !!msg.sgrMousePixelsMode
    })
  } else if (msg.type === 'terminal-input') {
    const bytes = typeof msg.bytes === 'string' ? msg.bytes : ''
    if (bytes.length > 0) {
      handlers.onTerminalInput?.(bytes)
    }
  } else if (msg.type === 'terminal-tap') {
    handlers.onTerminalTap?.()
  } else if (msg.type === 'terminal-file-tap') {
    const pathText = typeof msg.pathText === 'string' ? msg.pathText : ''
    if (pathText.length > 0) {
      const line = typeof msg.line === 'number' ? msg.line : null
      const column = typeof msg.column === 'number' ? msg.column : null
      handlers.onFileTap?.(pathText, line, column)
    }
  } else if (msg.type === 'open-url') {
    const url = typeof msg.url === 'string' ? msg.url : ''
    if (url.length > 0) {
      handlers.onOpenUrl?.(url)
    }
  } else if (msg.type === 'keyboard-avoidance-metrics') {
    const cursorY = typeof msg.cursorY === 'number' ? msg.cursorY : 0
    const rows = typeof msg.rows === 'number' ? msg.rows : 0
    handlers.onKeyboardAvoidanceMetrics?.({
      cursorY,
      rows,
      altScreen: !!msg.altScreen
    })
  } else if (msg.type === 'haptic') {
    const kind = msg.kind
    if (kind === 'selection' || kind === 'success' || kind === 'error' || kind === 'edge-bump') {
      handlers.onHaptic?.(kind)
    }
  } else if (msg.type === 'font-scale-changed') {
    const scale = typeof msg.fontScale === 'number' ? msg.fontScale : 0
    if (scale > 0) {
      handlers.onTextScaleChange?.(scale)
    }
  } else if (msg.type === 'mobile-clip-cancel-by-pinch') {
    // eslint-disable-next-line no-console
    console.warn('[mobile-clip] selection cancelled by pinch')
  }
}
