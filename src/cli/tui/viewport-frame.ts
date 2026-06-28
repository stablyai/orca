import { clipAnsi, fitCells, padCells } from './text-width'
import { visibleTailLines } from './pane-layout'
import { sanitizeToSgr } from './sgr-sanitize'
import type { TerminalAnsiFrame } from './terminal-ansi-source'

/** Number of screen lines the frame currently holds (after trimming trailing
 *  blanks) — the controller clamps the scrollback offset against this. */
export function terminalLineCount(frame: TerminalAnsiFrame): number {
  return frameLines(frame).length
}

/** Turn the focused terminal's frame into exactly `height` rows of exactly
 *  `width` visible cells, for placement in the viewport rectangle.
 *
 *  When ANSI data is present we slice it VERBATIM (byte-for-byte) — split into
 *  screen lines, window to `height` (scrolled back by `scrollOffset`), and clip
 *  each to `width` with an ANSI-aware slice that never splits an escape. No
 *  re-parsing through a terminal emulator: the runtime already serialized a
 *  faithful SGR screen. */
export function viewportRows(
  frame: TerminalAnsiFrame,
  width: number,
  height: number,
  scrollOffset = 0
): string[] {
  if (width <= 0 || height <= 0) {
    return []
  }
  const lines = frameLines(frame)
  if (lines.length === 0) {
    return placeholder(frame, width, height)
  }
  const visible = visibleTailLines(lines, height, scrollOffset)
  const rows: string[] = []
  for (const line of visible) {
    rows.push(padCells(clipAnsi(line, width), width))
  }
  while (rows.length < height) {
    rows.push(' '.repeat(width))
  }
  return rows
}

// terminalLineCount and viewportRows both derive lines from the same frame on a
// scroll/render tick; cache by frame identity so the split+sanitize runs once.
const linesCache = new WeakMap<TerminalAnsiFrame, string[]>()

/** The terminal's screen lines, newest last. Trailing blank lines are dropped so
 *  the live output sits at the bottom of the viewport (where a shell prompt is)
 *  rather than scrolled up by the serializer's full-height padding. */
function frameLines(frame: TerminalAnsiFrame): string[] {
  const cached = linesCache.get(frame)
  if (cached) {
    return cached
  }
  const lines = computeFrameLines(frame)
  linesCache.set(frame, lines)
  return lines
}

function computeFrameLines(frame: TerminalAnsiFrame): string[] {
  if (frame.data !== null) {
    // Split into screen lines without a control-char regex (lint: no-control-regex),
    // then reduce each to SGR + text so replay-only escapes can't corrupt layout.
    const split = frame.data
      .split('\r\n')
      .join('\n')
      .split('\n')
      .map((line) => sanitizeToSgr(line.endsWith('\r') ? line.slice(0, -1) : line))
    return trimTrailingBlank(split)
  }
  // Plain content (editor/markdown/file/browser) keeps its exact line count —
  // trimming trailing blanks here would desync the scroll/window math (counted
  // on the full buffer) from what's drawn, corrupting the view near the ends.
  return frame.plainLines.slice()
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length
  // Strip SGR before checking for blank so a styled-but-empty row still trims
  // (its escape codes aren't whitespace). Regex built without a literal control
  // char to satisfy no-control-regex.
  const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  while (
    end > 0 &&
    clipAnsi(lines[end - 1], 1000)
      .replace(sgr, '')
      .trim().length === 0
  ) {
    end -= 1
  }
  return lines.slice(0, end)
}

function placeholder(frame: TerminalAnsiFrame, width: number, height: number): string[] {
  // When the runtime lacks terminal.readAnsi the verbatim screen is unavailable
  // and the plain tail is usually empty — say so (and how to fix) rather than
  // implying the terminal itself produced nothing.
  const lines = frame.ansiUnsupported
    ? ['terminal screen needs a newer Orca runtime', 'rebuild & restart Orca to see live output']
    : [frame.connected ? 'no terminal output yet' : 'connecting…']
  const rows: string[] = []
  const top = Math.max(0, Math.floor((height - lines.length) / 2))
  for (let i = 0; i < height; i += 1) {
    const line = lines[i - top]
    rows.push(line ? fitCells(`  ${line}`, width) : ' '.repeat(width))
  }
  return rows
}
