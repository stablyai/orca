import { parseTerminalKittyKeyboardFlags } from '../../../src/shared/terminal-kitty-keyboard-flags'
import type { ParsedFileLinkLocation } from '../../../src/shared/file-link-location'
import { translate } from '../i18n/mobile-i18n'
import {
  parseTerminalKeyboardAvoidanceMetrics,
  type TerminalSelectionEvents
} from './terminal-webview-contract'

export type TerminalWebViewNotificationHandlers = Omit<
  TerminalSelectionEvents,
  'onTerminalQueryReply'
> & {
  reportEngineError: (message: string, fatal: boolean) => void
}

export function dispatchTerminalWebViewNotification(
  msg: Record<string, unknown>,
  handlers: TerminalWebViewNotificationHandlers
) {
  if (msg.type === 'log') {
    const tag = typeof msg.tag === 'string' ? msg.tag : '[fit]'
    console.log(tag, msg.payload)
  } else if (msg.type === 'error') {
    const message =
      typeof msg.message === 'string'
        ? msg.message
        : translate('terminal.webviewNotificationDispatch.unknownError', 'Unknown terminal error')
    handlers.reportEngineError(message, msg.fatal !== false)
  } else if (msg.type === 'set-select-mode') {
    handlers.onSelectionMode?.(!!msg.enabled)
  } else if (msg.type === 'selection') {
    const text = typeof msg.text === 'string' ? msg.text : ''
    handlers.onSelectionCopy?.(text)
  } else if (msg.type === 'clipboard-write') {
    if (typeof msg.text === 'string') {
      handlers.onClipboardWrite?.(msg.text)
    }
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
      sgrMousePixelsMode: !!msg.sgrMousePixelsMode,
      applicationCursorKeysMode: !!msg.applicationCursorKeysMode,
      kittyKeyboardFlags: parseTerminalKittyKeyboardFlags(msg.kittyKeyboardFlags) ?? 0,
      modifyOtherKeys: typeof msg.modifyOtherKeys === 'number' ? msg.modifyOtherKeys : 0
    })
  } else if (msg.type === 'terminal-input') {
    const bytes = typeof msg.bytes === 'string' ? msg.bytes : ''
    if (bytes.length > 0) {
      if (msg.click === true) {
        handlers.onTerminalInput?.(bytes, { click: true })
      } else {
        handlers.onTerminalInput?.(bytes)
      }
    }
  } else if (msg.type === 'terminal-interaction') {
    handlers.onTerminalInteraction?.()
  } else if (msg.type === 'terminal-tap') {
    handlers.onTerminalTap?.()
  } else if (msg.type === 'terminal-swipe-down') {
    handlers.onTerminalSwipeDown?.()
  } else if (msg.type === 'terminal-file-tap') {
    const candidates = parseFileTapCandidates(msg.candidates)
    if (candidates.length > 0) {
      handlers.onFileTap?.(candidates)
    }
  } else if (msg.type === 'open-url') {
    const url = typeof msg.url === 'string' ? msg.url : ''
    if (url.length > 0) {
      handlers.onOpenUrl?.(url)
    }
  } else if (msg.type === 'keyboard-avoidance-metrics') {
    handlers.onKeyboardAvoidanceMetrics?.(parseTerminalKeyboardAvoidanceMetrics(msg))
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
    console.warn('[mobile-clip] selection cancelled by pinch')
  }
}

function parseFileTapCandidates(value: unknown): ParsedFileLinkLocation[] {
  if (!Array.isArray(value)) {
    return []
  }
  const candidates: ParsedFileLinkLocation[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const pathText = 'pathText' in item && typeof item.pathText === 'string' ? item.pathText : ''
    if (pathText.length === 0) {
      continue
    }
    const line = 'line' in item && typeof item.line === 'number' ? item.line : null
    const column = 'column' in item && typeof item.column === 'number' ? item.column : null
    candidates.push({ pathText, line, column })
  }
  return candidates
}
