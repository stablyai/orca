import { style } from './ansi-control'
import { cellWidth, clipAnsi, fitCells, padCells, sliceCellsFrom } from './text-width'
import { keybindingHelp, type Platform } from './keybinding-map'

/** A modal drawn centered over the composed frame (help / confirm / prompt).
 *  Kept separate from layout so compose-frame stays focused on the dashboard. */
export type OverlayModel =
  | { kind: 'none' }
  | { kind: 'help'; platform: Platform }
  | { kind: 'confirm'; message: string }
  | { kind: 'prompt'; label: string; value: string }

type Box = { title: string; lines: string[] }

/** Stamp the overlay box over `base`, centered. The box is composited onto each
 *  row it occupies so the chrome to the left and right of the box still shows
 *  (only the box's own cells replace the base). Returns a new array. */
export function overlayRows(
  base: string[],
  overlay: OverlayModel,
  columns: number,
  rows: number,
  useColor: boolean
): string[] {
  if (overlay.kind === 'none') {
    return base
  }
  const box = boxFor(overlay)
  const innerWidth = boxInnerWidth(box, columns)
  const boxWidth = innerWidth + 4
  const boxLines = drawBox(box, innerWidth, useColor)
  const top = Math.max(0, Math.floor((rows - boxLines.length) / 2))
  const left = Math.max(0, Math.floor((columns - boxWidth) / 2))
  const out = base.slice()
  for (let i = 0; i < boxLines.length; i += 1) {
    const rowIndex = top + i
    if (rowIndex >= 0 && rowIndex < rows) {
      const baseRow = out[rowIndex] ?? ''
      const leftPart = padCells(clipAnsi(baseRow, left), left)
      const rightPart = sliceCellsFrom(baseRow, left + boxWidth)
      out[rowIndex] = leftPart + boxLines[i] + rightPart
    }
  }
  return out
}

/** Geometry for a click while an overlay is open. Recomputes the same centered
 *  box overlayRows draws, then classifies the click:
 *   - help: any click dismisses
 *   - confirm: the buttons row splits into yes (left half) / no (right half);
 *     a click outside the box cancels; elsewhere inside is ignored
 *   - prompt: a click outside cancels; inside is ignored (keyboard-driven) */
export function overlayClick(
  overlay: OverlayModel,
  columns: number,
  rows: number,
  col: number,
  row: number
): 'confirm' | 'cancel' | 'dismiss' | null {
  if (overlay.kind === 'none') {
    return null
  }
  const box = boxFor(overlay)
  const innerWidth = boxInnerWidth(box, columns)
  const boxWidth = innerWidth + 4
  const boxLines = drawBox(box, innerWidth, useColorIrrelevant)
  const top = Math.max(0, Math.floor((rows - boxLines.length) / 2))
  const left = Math.max(0, Math.floor((columns - boxWidth) / 2))
  const inside = row >= top && row < top + boxLines.length && col >= left && col < left + boxWidth
  if (overlay.kind === 'help') {
    return 'dismiss'
  }
  if (overlay.kind === 'prompt') {
    return inside ? null : 'cancel'
  }
  if (!inside) {
    return 'cancel'
  }
  // confirm: last body line (just above the bottom border) holds the buttons.
  if (row === top + boxLines.length - 2) {
    return col < left + 2 + Math.floor(innerWidth / 2) ? 'confirm' : 'cancel'
  }
  return null
}

// drawBox styling is irrelevant to geometry; pass a constant for measurement.
const useColorIrrelevant = false

/** Inner box width: the widest of the title (cell width) and the body lines,
 *  clamped to the screen and never negative (tiny terminals would break geometry). */
function boxInnerWidth(box: Box, columns: number): number {
  const inner = Math.max(cellWidth(` ${box.title} `), ...box.lines.map((line) => cellWidth(line)))
  return Math.max(0, Math.min(columns - 4, inner))
}

function boxFor(overlay: Exclude<OverlayModel, { kind: 'none' }>): Box {
  if (overlay.kind === 'help') {
    const lines = keybindingHelp(overlay.platform).map(
      (entry) => `${entry.keys.padEnd(10)} ${entry.hint}`
    )
    return { title: 'Help', lines: [...lines, '', 'press any key to close'] }
  }
  if (overlay.kind === 'confirm') {
    return { title: 'Confirm', lines: [overlay.message, '', 'y  yes      n  no'] }
  }
  return { title: 'Input', lines: [overlay.label, `> ${overlay.value}▏`] }
}

const H = '─'

function drawBox(box: Box, innerWidth: number, useColor: boolean): string[] {
  const rawTitle = ` ${box.title} `
  // Clip an over-long title to the top border span (innerWidth + 2) so it never
  // overflows the box; measure with cell width for the ─ fill.
  const titleBar =
    cellWidth(rawTitle) > innerWidth + 2 ? clipAnsi(rawTitle, innerWidth + 2) : rawTitle
  const fill = Math.max(0, innerWidth + 2 - cellWidth(titleBar))
  const top = style(`╭${titleBar}${H.repeat(fill)}╮`, { fg: 'gray', bold: true }, useColor)
  const bottom = style(`╰${H.repeat(innerWidth + 2)}╯`, { fg: 'gray' }, useColor)
  const body = box.lines.map((line) => {
    const edge = style('│', { fg: 'gray' }, useColor)
    return `${edge} ${fitCells(line, innerWidth)} ${edge}`
  })
  return [top, ...body, bottom]
}
