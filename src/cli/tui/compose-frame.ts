import { style } from './ansi-control'
import { cellWidth, fitCells } from './text-width'
import {
  focusBar,
  headerRow,
  sidebarRows,
  statusRow,
  statusStripRows,
  tabStripRow
} from './chrome-frame'
import { viewportRows } from './viewport-frame'
import { fileBrowserRows, type FileBrowserState } from './file-browser'
import { BACK_LABEL, STRIP_WIDTH } from './tui-layout'
import { overlayRows, type OverlayModel } from './overlay-frame'
import type { Platform } from './keybinding-map'
import type { StatusIndicatorKind } from './agent-state-indicator'
import type { SessionTab } from './session-tab'
import type { TerminalAnsiFrame } from './terminal-ansi-source'
import type { WorktreeRow, WorktreeSnapshot } from './worktree-snapshot'
import type { NarrowView } from './tui-layout'

/** Everything the frame needs to draw one screen. The controller keeps the
 *  mutable state; this turns a snapshot of it into exact-width rows. */
export type FrameModel = {
  columns: number
  rows: number
  isNarrow: boolean
  narrowView: NarrowView
  snapshot: WorktreeSnapshot | null
  worktreeRows: readonly WorktreeRow[]
  selectedIndex: number
  selectedName: string
  sidebarWidth: number
  tabs: readonly SessionTab[]
  /** All session tabs grouped by worktree, for the nested sidebar tab lines. */
  tabsByWorktree: ReadonlyMap<string, readonly SessionTab[]>
  tabsExpanded: boolean
  focusedTabId: string | null
  /** True when keystrokes/scroll are captured by the terminal (input focus). */
  terminalFocused: boolean
  /** Editor status for the focused tab (drives the editing footer hints). */
  editState: 'none' | 'clean' | 'dirty' | 'conflict'
  fileBrowser: FileBrowserState
  viewport: TerminalAnsiFrame
  /** Lines scrolled back from the live bottom of the focused terminal. */
  scrollOffset: number
  resolveKind: (row: WorktreeRow) => StatusIndicatorKind
  platform: Platform
  context: string
  disconnected: boolean
  error: string | null
  useColor: boolean
  overlay: OverlayModel
}

const BORDER = '│'

/** Compose the whole screen into `rows` full-width row strings (one per screen
 *  line), then stamp any active overlay over them. */
export function composeFrame(model: FrameModel): string[] {
  const bodyHeight = Math.max(1, model.rows - 2)
  const base =
    model.isNarrow && model.fileBrowser.open
      ? narrowFilesFrame(model, bodyHeight)
      : model.isNarrow && model.narrowView === 'terminal'
        ? narrowTerminalFrame(model, bodyHeight)
        : model.isNarrow
          ? narrowListFrame(model, bodyHeight)
          : wideFrame(model, bodyHeight)
  return overlayRows(base, model.overlay, model.columns, model.rows, model.useColor)
}

/** Narrow single-column Files browser (full-width list). */
function narrowFilesFrame(model: FrameModel, bodyHeight: number): string[] {
  return [
    headerRow(headerLabel(model), model.columns, model.useColor),
    ...fileBrowserRows(model.fileBrowser, model.columns, bodyHeight, model.useColor),
    statusFooter(model)
  ]
}

function headerLabel(model: FrameModel): string {
  const count = model.worktreeRows.length
  return ` orca tui · ${count} worktree${count === 1 ? '' : 's'}`
}

function sidebarTabsOptions(model: FrameModel): {
  tabsByWorktree: ReadonlyMap<string, readonly SessionTab[]>
  expanded: boolean
  focusedTabId: string | null
} {
  return {
    tabsByWorktree: model.tabsByWorktree,
    expanded: model.tabsExpanded,
    focusedTabId: model.focusedTabId
  }
}

function wideFrame(model: FrameModel, bodyHeight: number): string[] {
  const viewportWidth = Math.max(1, model.columns - model.sidebarWidth - 2)
  const left = sidebarRows(
    model.snapshot,
    model.selectedIndex,
    bodyHeight,
    model.sidebarWidth,
    model.resolveKind,
    model.useColor,
    sidebarTabsOptions(model)
  )
  // A heavy divider marks the input-focused side; the body keeps a one-space
  // margin after it, but the tab strip sits flush against the bar.
  const bar = model.terminalFocused
    ? style('┃', { fg: 'white', bold: true }, model.useColor)
    : style(BORDER, { dim: true }, model.useColor)
  const sep = `${bar} `
  const rows = [wideHeader(model)]
  if (model.fileBrowser.open) {
    const browser = fileBrowserRows(model.fileBrowser, viewportWidth, bodyHeight, model.useColor)
    for (let i = 0; i < bodyHeight; i += 1) {
      rows.push(`${left[i]}${sep}${browser[i]}`)
    }
  } else {
    // Tab strip flush against the bar and one column wider; body keeps the margin.
    const tab = tabStripRow(model.tabs, model.focusedTabId, viewportWidth + 1, model.useColor)
    const body = viewportRows(
      model.viewport,
      viewportWidth,
      Math.max(0, bodyHeight - 1),
      model.scrollOffset
    )
    rows.push(`${left[0]}${bar}${tab}`)
    for (let i = 1; i < bodyHeight; i += 1) {
      rows.push(`${left[i]}${sep}${body[i - 1] ?? ' '.repeat(viewportWidth)}`)
    }
  }
  rows.push(wideFooter(model))
  return rows
}

/** Top focus bar (wide): brand + count on the workspace side, the selected
 *  workspace/branch on the terminal side, the focused side blue. */
function wideHeader(model: FrameModel): string {
  const count = model.worktreeRows.length
  const left = ` orca tui · ${count} ws`
  // Pin the Files button to the far-right corner, leaving one trailing column so
  // its closing bracket isn't flush against the screen edge.
  const button = '[ f Files ] '
  const segWidth = Math.max(0, model.columns - model.sidebarWidth)
  const label = model.context ? ` ${model.context}` : ' terminal'
  const right = fitCells(label, Math.max(0, segWidth - cellWidth(button))) + button
  return focusBar(
    left,
    model.sidebarWidth,
    right,
    model.columns,
    model.terminalFocused,
    model.useColor
  )
}

/** Bottom focus bar (wide): nav hints on the workspace side, terminal hints on
 *  the terminal side, the focused side blue. Errors/disconnects take the whole
 *  bar so they aren't missed. */
function wideFooter(model: FrameModel): string {
  if (model.error) {
    return style(
      fitCells(` ${model.error}`, model.columns),
      { bg: 'red', fg: 'white', bold: true },
      model.useColor
    )
  }
  if (model.disconnected) {
    return style(
      fitCells(' runtime disconnected — reconnecting…', model.columns),
      { bg: 'yellow', fg: 'black' },
      model.useColor
    )
  }
  const nav = ' ↑↓ move · ⏎ focus · t tabs · f files · n new · q quit'
  const term =
    model.editState === 'conflict'
      ? ' ⚠ changed on disk — Ctrl-S overwrites · Ctrl-G discards · Ctrl-] exit'
      : model.editState !== 'none'
        ? ` ✎ editing${model.editState === 'dirty' ? ' ●' : ''} · Ctrl-S save · Ctrl-G discard · Ctrl-] exit`
        : ' ⎋⎋ or Ctrl-] nav · wheel scrolls · keys → terminal'
  return focusBar(
    nav,
    model.sidebarWidth,
    term,
    model.columns,
    model.terminalFocused,
    model.useColor
  )
}

function narrowListFrame(model: FrameModel, bodyHeight: number): string[] {
  const body = sidebarRows(
    model.snapshot,
    model.selectedIndex,
    bodyHeight,
    model.columns,
    model.resolveKind,
    model.useColor,
    sidebarTabsOptions(model)
  )
  return [
    headerRow(headerLabel(model), model.columns, model.useColor),
    ...body,
    statusFooter(model)
  ]
}

function narrowTerminalFrame(model: FrameModel, bodyHeight: number): string[] {
  const viewportWidth = Math.max(1, model.columns - STRIP_WIDTH - 1)
  const strip = statusStripRows(
    model.worktreeRows,
    model.selectedIndex,
    bodyHeight,
    model.resolveKind,
    model.useColor
  )
  const right = rightColumn(model, viewportWidth, bodyHeight)
  const backWidth = Math.min(model.columns, cellWidth(BACK_LABEL))
  const back = style(
    fitCells(BACK_LABEL, backWidth),
    { bg: 'white', fg: 'black', bold: true },
    model.useColor
  )
  const title = style(
    fitCells(` ${model.selectedName}`, Math.max(0, model.columns - backWidth)),
    { bold: true },
    model.useColor
  )
  const rows = [back + title]
  for (let i = 0; i < bodyHeight; i += 1) {
    rows.push(`${strip[i]} ${right[i]}`)
  }
  rows.push(statusFooter(model))
  return rows
}

/** The right pane: tab strip on top, the focused terminal's verbatim output
 *  below — herdr-style tabs-over-terminal. */
function rightColumn(model: FrameModel, width: number, bodyHeight: number): string[] {
  if (model.fileBrowser.open) {
    return fileBrowserRows(model.fileBrowser, width, bodyHeight, model.useColor)
  }
  const tab = tabStripRow(model.tabs, model.focusedTabId, width, model.useColor)
  const body = viewportRows(model.viewport, width, Math.max(0, bodyHeight - 1), model.scrollOffset)
  return [tab, ...body]
}

function statusFooter(model: FrameModel): string {
  return statusRow(
    model.columns,
    model.platform,
    model.context,
    model.disconnected,
    model.error,
    model.terminalFocused,
    model.useColor
  )
}
