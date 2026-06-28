import { style, type TextStyle } from './ansi-control'
import { cellWidth, fitCells } from './text-width'
import { indicatorFor } from './agent-state-indicator'
import {
  buildSidebarLines,
  sidebarWindowStart,
  type SidebarLine,
  type SidebarTabsOptions
} from './sidebar-lines'
import { windowStart } from './navigation-state'
import { tabStripLabel, tabStripStart, truncateTabLabel } from './pane-layout'
import { statusBarHelp, type Platform } from './keybinding-map'
import { tabGlyph, type SessionTab } from './session-tab'
import type { StatusIndicatorKind } from './agent-state-indicator'
import type { WorktreeRow, WorktreeSnapshot } from './worktree-snapshot'

/** Renders the dashboard chrome (header, sidebar, tab strip, status bar) as
 *  exact-width styled strings the compositor lays into fixed rectangles. Pure so
 *  the layout matches the mouse hit-testing geometry exactly. */

export function headerRow(label: string, width: number, useColor: boolean): string {
  return style(fitCells(label, width), { bg: 'white', fg: 'black', bold: true }, useColor)
}

/** A two-segment bar split at the sidebar divider: the focused side is a solid
 *  white bar, the other gray. Used for both the top and bottom bars so which
 *  pane has focus — workspaces (left) or terminal (right) — reads at a glance. */
export function focusBar(
  left: string,
  leftWidth: number,
  right: string,
  totalWidth: number,
  terminalFocused: boolean,
  useColor: boolean
): string {
  const active: TextStyle = { bg: 'white', fg: 'black', bold: true }
  const idle: TextStyle = { bg: 'gray', fg: 'white' }
  // Clamp so the two segments always sum to exactly totalWidth, even if the
  // sidebar width somehow exceeds the screen.
  const lw = Math.max(0, Math.min(leftWidth, totalWidth))
  const leftSeg = style(fitCells(left, lw), terminalFocused ? idle : active, useColor)
  const rightSeg = style(
    fitCells(right, totalWidth - lw),
    terminalFocused ? active : idle,
    useColor
  )
  return leftSeg + rightSeg
}

/** The vertical column of worktree status glyphs for the narrow terminal view. */
export function statusStripRows(
  rows: readonly WorktreeRow[],
  selectedIndex: number,
  height: number,
  resolveKind: (row: WorktreeRow) => StatusIndicatorKind,
  useColor: boolean
): string[] {
  const start = windowStart(selectedIndex, rows.length, height)
  const out: string[] = []
  for (let i = 0; i < height; i += 1) {
    const row = rows[start + i]
    if (!row) {
      out.push('  ')
      continue
    }
    const indicator = indicatorFor(resolveKind(row))
    const selected = start + i === selectedIndex
    out.push(
      style(
        `${indicator.glyph} `,
        selected ? { inverse: true, bold: true } : { fg: indicator.color },
        useColor
      )
    )
  }
  return out
}

export function tabStripRow(
  tabs: readonly SessionTab[],
  focusedTabId: string | null,
  width: number,
  useColor: boolean
): string {
  if (tabs.length === 0) {
    return style(
      fitCells(' no tabs — press c for a terminal, f for files', width),
      { dim: true },
      useColor
    )
  }
  const focused = focusedTabId ?? tabs[0].id
  // Scroll the strip horizontally so the focused tab is on screen.
  const start = tabStripStart(tabs, focusedTabId, width)
  let out = ''
  let used = 0
  for (let i = start; i < tabs.length; i += 1) {
    const tab = tabs[i]
    // First visible tab is flush at the box edge (no leading pad); later tabs
    // keep a leading space so the gap between tabs stays. All get one trailing.
    const label = `${i === start ? '' : ' '}${tabStripLabel(tab)} `
    if (used + cellWidth(label) > width) {
      break
    }
    const spec: TextStyle =
      tab.id === focused ? { bg: 'orange', fg: 'black', bold: true } : { dim: true }
    out += style(label, spec, useColor)
    used += cellWidth(label)
  }
  return out + ' '.repeat(Math.max(0, width - used))
}

export function statusRow(
  width: number,
  platform: Platform,
  context: string,
  disconnected: boolean,
  error: string | null,
  terminalFocused: boolean,
  useColor: boolean
): string {
  if (error) {
    return style(fitCells(` ${error}`, width), { fg: 'red', bold: true }, useColor)
  }
  if (disconnected) {
    return style(
      fitCells(' runtime disconnected — reconnecting…', width),
      { fg: 'yellow' },
      useColor
    )
  }
  // In terminal focus, keystrokes go to the PTY — show how to get back and scroll
  // rather than the navigation keymap (which is inactive).
  if (terminalFocused) {
    const leftLabel = ' ● terminal '
    const leftWidth = Math.min(width, cellWidth(leftLabel))
    const left = style(
      fitCells(leftLabel, leftWidth),
      { bg: 'white', fg: 'black', bold: true },
      useColor
    )
    const rest = style(
      fitCells(
        ' Ctrl-] navigate · wheel scrolls history · keys → terminal',
        Math.max(0, width - leftWidth)
      ),
      { dim: true },
      useColor
    )
    return left + rest
  }
  const hints = statusBarHelp(platform)
    .map((hint) => `${hint.keys} ${hint.hint}`)
    .join('  ')
  const label = context ? `${context}  ` : ''
  const leftWidth = Math.min(width, cellWidth(label))
  const ctx = style(fitCells(label, leftWidth), { fg: 'white' }, useColor)
  const rest = style(fitCells(hints, Math.max(0, width - leftWidth)), { dim: true }, useColor)
  return ctx + rest
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function sidebarRows(
  snapshot: WorktreeSnapshot | null,
  selectedIndex: number,
  height: number,
  width: number,
  resolveKind: (row: WorktreeRow) => StatusIndicatorKind,
  useColor: boolean,
  tabs: SidebarTabsOptions = {}
): string[] {
  const lines = buildSidebarLines(snapshot, resolveKind, tabs)
  if (!lines.some((line) => line.kind === 'row')) {
    return emptySidebar(height, width, useColor)
  }
  const start = sidebarWindowStart(lines, selectedIndex, height)
  const out: string[] = []
  for (let i = 0; i < height; i += 1) {
    const line = lines[start + i]
    out.push(line ? renderSidebarLine(line, selectedIndex, width, useColor) : ' '.repeat(width))
  }
  return out
}

function emptySidebar(height: number, width: number, useColor: boolean): string[] {
  const out: string[] = []
  for (let i = 0; i < height; i += 1) {
    if (i === 0) {
      out.push(style(fitCells('WORKSPACES', width), { bold: true }, useColor))
    } else if (i === 2) {
      out.push(style(fitCells('No workspaces yet.', width), { dim: true }, useColor))
    } else {
      out.push(' '.repeat(width))
    }
  }
  return out
}

function renderSidebarLine(
  line: SidebarLine,
  selectedIndex: number,
  width: number,
  useColor: boolean
): string {
  if (line.kind === 'header') {
    return style(fitCells('WORKSPACES', width), { bold: true }, useColor)
  }
  if (line.kind === 'spacer') {
    return ' '.repeat(width)
  }
  if (line.kind === 'group') {
    return style(fitCells(line.repo, width), { dim: true }, useColor)
  }
  if (line.kind === 'tab') {
    return renderTabLine(line, width, useColor)
  }
  return renderWorktreeRow(line, line.index === selectedIndex, width, useColor)
}

/** A nested terminal tab under its worktree: indented, focused tab highlighted. */
function renderTabLine(
  line: Extract<SidebarLine, { kind: 'tab' }>,
  width: number,
  useColor: boolean
): string {
  const label = `   ${tabGlyph(line.tabKind)} ${truncateTabLabel(line.title)}`
  return style(
    fitCells(label, width),
    line.focused ? { fg: 'white', bold: true } : { dim: true },
    useColor
  )
}

function renderWorktreeRow(
  line: Extract<SidebarLine, { kind: 'row' }>,
  selected: boolean,
  width: number,
  useColor: boolean
): string {
  const indicator = indicatorFor(line.indicator)
  if (selected) {
    const text = `${indicator.glyph} ${line.displayName}${line.badges ? `  ${line.badges}` : ''}`
    return style(fitCells(text, width), { inverse: true, bold: true }, useColor)
  }
  const glyph = style(`${indicator.glyph} `, { fg: indicator.color }, useColor)
  const badgeWidth = line.badges ? cellWidth(line.badges) + 1 : 0
  const nameWidth = Math.max(0, width - 2 - badgeWidth)
  const name = fitCells(line.displayName, nameWidth)
  const badges = line.badges ? ` ${style(line.badges, { dim: true }, useColor)}` : ''
  // Final clamp keeps the row exactly `width` even when badges run long.
  return fitCells(`${glyph}${name}${badges}`, width)
}
