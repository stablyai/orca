import type { RuntimeMobileTerminalTheme } from '../../../src/shared/runtime-types'
import type { TerminalOscLinkRange } from '../../../src/shared/terminal-osc-link-ranges'
import type { StyleProp, ViewStyle } from 'react-native'
import type { TerminalFitDimensions } from './terminal-grid-fit'
import type { TerminalFrame } from './terminal-webview-messages'

type TerminalMouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

export type TerminalModes = {
  bracketedPasteMode: boolean
  altScreen: boolean
  mouseTrackingMode: TerminalMouseTrackingMode
  sgrMouseMode: boolean
  sgrMousePixelsMode: boolean
  applicationCursorKeysMode: boolean
  kittyKeyboardFlags: number
  modifyOtherKeys: number
}

export type TerminalKeyboardAvoidanceMetrics = {
  cursorY: number
  contentBottomRow: number
  rows: number
  altScreen: boolean
  // Drawn CSS row pitch includes fit scale; older/unmeasured documents omit it.
  rowPitch?: number
}

export function sameTerminalKeyboardAvoidanceMetrics(
  a: TerminalKeyboardAvoidanceMetrics,
  b: TerminalKeyboardAvoidanceMetrics
): boolean {
  return (
    a.cursorY === b.cursorY &&
    a.contentBottomRow === b.contentBottomRow &&
    a.rows === b.rows &&
    a.altScreen === b.altScreen &&
    a.rowPitch === b.rowPitch
  )
}

export function parseTerminalKeyboardAvoidanceMetrics(
  msg: Record<string, unknown>
): TerminalKeyboardAvoidanceMetrics {
  const rows = toNonNegativeInteger(msg.rows)
  const maxRow = Math.max(0, rows - 1)
  const cursorY = Math.min(toNonNegativeInteger(msg.cursorY), maxRow)
  const contentBottomRow =
    msg.contentBottomRow === undefined
      ? cursorY
      : Math.min(toNonNegativeInteger(msg.contentBottomRow), maxRow)
  const metrics = { cursorY, contentBottomRow, rows, altScreen: msg.altScreen === true }
  const rowPitch = msg.rowPitch
  return typeof rowPitch === 'number' && Number.isFinite(rowPitch) && rowPitch > 0
    ? { ...metrics, rowPitch }
    : metrics
}

function toNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export type MobileTerminalTheme = RuntimeMobileTerminalTheme

export type TerminalPointerInput = {
  readonly click: boolean
}

export type TerminalSelectionEvents = {
  onSelectionMode?: (active: boolean) => void
  onSelectionCopy?: (text: string) => void
  onSelectionEvicted?: () => void
  onClipboardWrite?: (text: string) => void
  onModesChanged?: (modes: TerminalModes) => void
  onKeyboardAvoidanceMetrics?: (metrics: TerminalKeyboardAvoidanceMetrics) => void
  onHaptic?: (kind: 'selection' | 'success' | 'error' | 'edge-bump') => void
  onTerminalInput?: (bytes: string, input?: TerminalPointerInput) => void
  onTerminalQueryReply?: (bytes: string) => void
  onTerminalTap?: () => void
  onFileTap?: (pathText: string, line: number | null, column: number | null) => void
  onOpenUrl?: (url: string) => void
  // Persist snapped text-size presets so Settings and other panes follow terminal pinches.
  onTextScaleChange?: (scale: number) => void
  onCellBoxChange?: () => void
}

export type TerminalWebViewProps = {
  style?: StyleProp<ViewStyle>
  terminalTheme?: MobileTerminalTheme
  // Persistent font-size preset; transient CSS pinch zoom is committed into it on release.
  textScale?: number
  // Only initially shown views build pre-ready engines, limiting WebGL context use.
  shownAtMount?: boolean
  onWebReady?: () => void
  onEngineError?: (message: string) => void
} & TerminalSelectionEvents

export type TerminalInit = {
  cols: number
  rows: number
  initialData?: string
  preserveScroll?: boolean
  oscLinks?: TerminalOscLinkRange[]
  // The host snapshot's proven Kitty keyboard flags, unvalidated.
  kittyFlags?: unknown
  frame: TerminalFrame | null
}

export type TerminalWebViewHandle = {
  // iOS can preserve the view but lose document state; await liveness before foreground replay.
  prepareForForegroundRecovery: () => void
  write: (data: string) => void
  init: (init: TerminalInit) => void
  resize: (cols: number, rows: number, frame: TerminalFrame | null) => void
  // Rewrap local scrollback after PTY width changes; alternate screens use full repaints instead.
  reflow: (cols: number, rows: number, frame: TerminalFrame | null) => void
  clear: () => void
  fitDimensions: (frame: TerminalFrame) => TerminalFitDimensions | null
  resetZoom: () => void
  cancelSelect: () => void
  doSelectAll: () => void
  // Await the latest init’s ready notification so follow-up fitting uses its post-layout cell box.
  awaitReady: () => Promise<void>
}
