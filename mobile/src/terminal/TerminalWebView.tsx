import { useRef, useCallback, forwardRef, useImperativeHandle, useEffect, useMemo } from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { WebView } from 'react-native-webview'
import type { WebViewMessageEvent } from 'react-native-webview'
import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import { colors } from '../theme/mobile-theme'
import { XTERM_HTML } from './terminal-webview-html'
import type { TerminalWebViewCommand } from './terminal-webview-messages'

type TerminalMouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

export type TerminalModes = {
  bracketedPasteMode: boolean
  altScreen: boolean
  mouseTrackingMode: TerminalMouseTrackingMode
  sgrMouseMode: boolean
  sgrMousePixelsMode: boolean
}

export type TerminalKeyboardAvoidanceMetrics = {
  cursorY: number
  rows: number
  altScreen: boolean
}

export type MobileTerminalTheme = RuntimeMobileTerminalTheme

export type TerminalSelectionEvents = {
  onSelectionMode?: (active: boolean) => void
  onSelectionCopy?: (text: string) => void
  onSelectionEvicted?: () => void
  onModesChanged?: (modes: TerminalModes) => void
  onKeyboardAvoidanceMetrics?: (metrics: TerminalKeyboardAvoidanceMetrics) => void
  onHaptic?: (kind: 'selection' | 'success' | 'error' | 'edge-bump') => void
  onTerminalInput?: (bytes: string) => void
  onTerminalTap?: () => void
  // Tap landed on a detected file path; RN resolves + opens it.
  onFileTap?: (pathText: string, line: number | null, column: number | null) => void
  // WebView-detected URL tap; RN chooses the mobile routing destination.
  onOpenUrl?: (url: string) => void
  // Why: pinch-to-zoom in the terminal snaps to a text-size preset and reports it
  // here so the app persists it and keeps Settings + other panes in sync.
  onTextScaleChange?: (scale: number) => void
}

export type TerminalWebViewHandle = {
  write: (data: string) => void
  init: (cols: number, rows: number, initialData?: string) => void
  resize: (cols: number, rows: number) => void
  clear: () => void
  measureFitDimensions: (containerHeight?: number) => Promise<{ cols: number; rows: number } | null>
  resetZoom: () => void
  cancelSelect: () => void
  doSelectAll: () => void
  // Why: lets callers await the WebView-side `init` rAF chain (term.open
  // → renderService population → first paint) so a follow-up measure
  // doesn't race ahead and find term=null or cellWidth=0. Resolves on
  // the next 'ready' notify after the most recent init.
  awaitReady: () => Promise<void>
}

type Props = {
  style?: StyleProp<ViewStyle>
  terminalTheme?: MobileTerminalTheme
  // Why: baseline zoom multiplier ("text size") applied on top of the fit-to-width
  // scale; raw xterm fontSize can't drive apparent size because the fit cancels it.
  textScale?: number
  onWebReady?: () => void
} & TerminalSelectionEvents

const MAX_PENDING_WEB_WRITE_BYTES = 1_000_000
const MAX_PENDING_WEB_WRITE_MESSAGES = 4096

export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(function TerminalWebView(
  {
    style,
    terminalTheme,
    textScale = 1,
    onWebReady,
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
  },
  ref
) {
  const webViewRef = useRef<WebView>(null)
  const isWebReadyRef = useRef(false)
  const pendingMessagesRef = useRef<TerminalWebViewCommand[]>([])
  const pendingWriteBytesRef = useRef(0)
  const pendingWriteCountRef = useRef(0)
  const messageIdRef = useRef(0)
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

  const sendToWebView = useCallback((msg: TerminalWebViewCommand) => {
    messageIdRef.current += 1
    webViewRef.current?.postMessage(JSON.stringify({ ...msg, id: messageIdRef.current }))
  }, [])

  const flushPendingMessages = useCallback(() => {
    const pending = pendingMessagesRef.current
    pendingMessagesRef.current = []
    pendingWriteBytesRef.current = 0
    pendingWriteCountRef.current = 0
    for (const msg of pending) {
      sendToWebView(msg)
    }
  }, [sendToWebView])

  const clearPendingMessages = useCallback(() => {
    pendingMessagesRef.current = []
    pendingWriteBytesRef.current = 0
    pendingWriteCountRef.current = 0
  }, [])

  const queuePendingMessage = useCallback((msg: TerminalWebViewCommand) => {
    const pending = pendingMessagesRef.current
    pending.push(msg)
    if (msg.type !== 'write') {
      return
    }

    pendingWriteBytesRef.current += msg.data.length
    pendingWriteCountRef.current += 1
    while (
      pendingWriteBytesRef.current > MAX_PENDING_WEB_WRITE_BYTES ||
      pendingWriteCountRef.current > MAX_PENDING_WEB_WRITE_MESSAGES
    ) {
      const dropIndex = pending.findIndex((candidate) => candidate.type === 'write')
      if (dropIndex === -1) {
        pendingWriteBytesRef.current = 0
        pendingWriteCountRef.current = 0
        return
      }
      const [dropped] = pending.splice(dropIndex, 1)
      if (dropped?.type === 'write') {
        pendingWriteBytesRef.current = Math.max(
          0,
          pendingWriteBytesRef.current - dropped.data.length
        )
        pendingWriteCountRef.current = Math.max(0, pendingWriteCountRef.current - 1)
      }
    }
  }, [])

  const postMessage = useCallback(
    (msg: TerminalWebViewCommand) => {
      if (!isWebReadyRef.current) {
        queuePendingMessage(msg)
        return
      }
      sendToWebView(msg)
    },
    [queuePendingMessage, sendToWebView]
  )

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.nativeEvent.data) as Record<string, unknown>
      } catch {
        return
      }

      if (msg.type === 'web-ready') {
        isWebReadyRef.current = true
        onWebReady?.()
        flushPendingMessages()
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
      } else if (msg.type === 'log') {
        // Surface fit-scale diagnostics in the RN/Metro console.
        const tag = typeof msg.tag === 'string' ? msg.tag : '[fit]'
        // eslint-disable-next-line no-console
        console.log(tag, msg.payload)
      } else if (msg.type === 'set-select-mode') {
        onSelectionMode?.(!!msg.enabled)
      } else if (msg.type === 'selection') {
        const text = typeof msg.text === 'string' ? msg.text : ''
        onSelectionCopy?.(text)
      } else if (msg.type === 'selection-evicted') {
        onSelectionEvicted?.()
      } else if (msg.type === 'modes') {
        const mouseTrackingMode =
          msg.mouseTrackingMode === 'x10' ||
          msg.mouseTrackingMode === 'vt200' ||
          msg.mouseTrackingMode === 'drag' ||
          msg.mouseTrackingMode === 'any'
            ? msg.mouseTrackingMode
            : 'none'
        onModesChanged?.({
          bracketedPasteMode: !!msg.bracketedPasteMode,
          altScreen: !!msg.altScreen,
          mouseTrackingMode,
          sgrMouseMode: !!msg.sgrMouseMode,
          sgrMousePixelsMode: !!msg.sgrMousePixelsMode
        })
      } else if (msg.type === 'terminal-input') {
        const bytes = typeof msg.bytes === 'string' ? msg.bytes : ''
        if (bytes.length > 0) {
          onTerminalInput?.(bytes)
        }
      } else if (msg.type === 'terminal-tap') {
        onTerminalTap?.()
      } else if (msg.type === 'terminal-file-tap') {
        const pathText = typeof msg.pathText === 'string' ? msg.pathText : ''
        if (pathText.length > 0) {
          const line = typeof msg.line === 'number' ? msg.line : null
          const column = typeof msg.column === 'number' ? msg.column : null
          onFileTap?.(pathText, line, column)
        }
      } else if (msg.type === 'open-url') {
        const url = typeof msg.url === 'string' ? msg.url : ''
        if (url.length > 0) {
          onOpenUrl?.(url)
        }
      } else if (msg.type === 'keyboard-avoidance-metrics') {
        const cursorY = typeof msg.cursorY === 'number' ? msg.cursorY : 0
        const rows = typeof msg.rows === 'number' ? msg.rows : 0
        onKeyboardAvoidanceMetrics?.({
          cursorY,
          rows,
          altScreen: !!msg.altScreen
        })
      } else if (msg.type === 'haptic') {
        const kind = msg.kind
        if (
          kind === 'selection' ||
          kind === 'success' ||
          kind === 'error' ||
          kind === 'edge-bump'
        ) {
          onHaptic?.(kind)
        }
      } else if (msg.type === 'font-scale-changed') {
        const scale = typeof msg.fontScale === 'number' ? msg.fontScale : 0
        if (scale > 0) {
          onTextScaleChange?.(scale)
        }
      } else if (msg.type === 'mobile-clip-cancel-by-pinch') {
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] selection cancelled by pinch')
      }
    },
    [
      flushPendingMessages,
      onWebReady,
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
    ]
  )

  const handleLoadStart = useCallback(() => {
    isWebReadyRef.current = false
    // Why: messages queued for a previous WebView generation are stale after a reload;
    // dropping them avoids replaying terminal chunks before the next init snapshot.
    clearPendingMessages()
  }, [clearPendingMessages])

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
    () => ({
      write(data: string) {
        postMessage({ type: 'write', data })
      },
      init(cols: number, rows: number, initialData?: string) {
        // Why: arm a fresh ready promise BEFORE posting init. The WebView
        // resolves it via the 'ready' notify at the end of its rAF chain.
        // Resolve any prior in-flight ready first so awaiters from the
        // previous generation don't sit on the 3s setTimeout fallback —
        // each leaked timer + closure pinned an awaiting measure caller
        // for the full 3s under rapid re-init (orientation change,
        // multiple resubscribes), delaying cold-start fit chains.
        const priorResolve = readyResolveRef.current
        if (priorResolve) {
          readyResolveRef.current = null
          readyPromiseRef.current = null
          priorResolve()
        }
        readyPromiseRef.current = new Promise<void>((resolve) => {
          readyResolveRef.current = resolve
        })
        postMessage({ type: 'init', cols, rows, initialData, terminalTheme, fontScale: textScale })
      },
      resize(cols: number, rows: number) {
        postMessage({ type: 'resize', cols, rows })
      },
      clear() {
        postMessage({ type: 'clear' })
      },
      measureFitDimensions(
        containerHeight?: number
      ): Promise<{ cols: number; rows: number } | null> {
        if (!isWebReadyRef.current) {
          return Promise.resolve(null)
        }
        return new Promise((resolve) => {
          measureResolveRef.current?.(null)
          let timeout: ReturnType<typeof setTimeout> | null = null
          const finish = (result: { cols: number; rows: number } | null) => {
            if (timeout) {
              clearTimeout(timeout)
              timeout = null
            }
            if (measureResolveRef.current === finish) {
              measureResolveRef.current = null
            }
            resolve(result)
          }
          measureResolveRef.current = finish
          sendToWebView({ type: 'measure', containerHeight })
          // Why: if the WebView doesn't respond within 2s (e.g., xterm
          // failed to load), resolve null so the caller can disable
          // Fit to Phone rather than hanging indefinitely.
          timeout = setTimeout(() => {
            if (measureResolveRef.current === finish) {
              finish(null)
            }
          }, 2000)
        })
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
      async awaitReady(): Promise<void> {
        // Why: returns the in-flight ready promise (set by init); resolves
        // immediately if no init is pending. Capped at 3s so a stuck
        // WebView doesn't hang the caller.
        const p = readyPromiseRef.current
        if (!p) {
          return
        }
        await new Promise<void>((resolve) => {
          let settled = false
          const timeout = setTimeout(() => {
            settled = true
            resolve()
          }, 3000)
          void p.finally(() => {
            if (!settled) {
              clearTimeout(timeout)
              settled = true
              resolve()
            }
          })
        })
      }
    }),
    [postMessage, sendToWebView, terminalTheme, textScale]
  )

  return (
    <WebView
      ref={webViewRef}
      source={{ html: XTERM_HTML }}
      style={[styles.webview, style]}
      originWhitelist={['*']}
      javaScriptEnabled
      scrollEnabled={false}
      scalesPageToFit={false}
      // Why: Android WebView defaults textZoom to the system font scale, inflating
      // xterm's DOM glyphs past its canvas-measured cell grid (#4579). iOS ignores it.
      textZoom={100}
      onLoadStart={handleLoadStart}
      onMessage={handleMessage}
    />
  )
})

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: colors.terminalBg
  }
})
