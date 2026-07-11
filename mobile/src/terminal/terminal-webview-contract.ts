import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import type { StyleProp, ViewStyle } from 'react-native'
import type { TerminalOscLinkRange } from './terminal-osc-link-ranges'

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

export type TerminalWebViewProps = {
  style?: StyleProp<ViewStyle>
  terminalTheme?: MobileTerminalTheme
  // Why: baseline zoom multiplier applied on top of fit-to-width scale; raw
  // xterm fontSize alone cannot drive apparent size because fitting cancels it.
  textScale?: number
  onWebReady?: () => void
  onEngineError?: (message: string) => void
} & TerminalSelectionEvents

export type TerminalWebViewHandle = {
  // Why: iOS can preserve the native view while discarding its JS/backing-store
  // state; foreground recovery must wait for the document to answer before replay.
  prepareForForegroundRecovery: () => void
  write: (data: string) => void
  init: (
    cols: number,
    rows: number,
    initialData?: string,
    preserveScroll?: boolean,
    oscLinks?: TerminalOscLinkRange[]
  ) => void
  resize: (cols: number, rows: number) => void
  // Why: reflow the local xterm buffer (scrollback included) to a new width
  // after a server-side PTY reflow, so older wrapped lines rewrap to match the
  // latest output. No-op on the alternate screen.
  reflow: (cols: number, rows: number) => void
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
