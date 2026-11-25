import type { Terminal } from '@xterm/headless'

type LiveBuffer = {
  length: () => number
  line: (index: number) => unknown
  popLine: () => void
  ybase: () => number
  y: () => number
  x: () => number
  /** True when an app set a DECSTBM scroll region narrower than the screen. */
  hasScrollRegion: (rows: number) => boolean
  /** Moves the viewport's top up by one row into its scrollback, keeping the cursor on its text. */
  showOneMoreScrollbackRow: () => void
}

// xterm keeps its live buffer on the private core; every field is checked, so a renamed one only
// falls back to xterm's own resize.
function liveBuffer(terminal: Terminal): LiveBuffer | null {
  const core: unknown = '_core' in terminal ? terminal._core : null
  if (typeof core !== 'object' || core === null || !('buffer' in core)) {
    return null
  }
  const buffer: unknown = core.buffer
  if (
    typeof buffer !== 'object' ||
    buffer === null ||
    !('lines' in buffer) ||
    !('ybase' in buffer) ||
    !('ydisp' in buffer) ||
    !('y' in buffer) ||
    !('x' in buffer) ||
    !('scrollTop' in buffer) ||
    !('scrollBottom' in buffer)
  ) {
    return null
  }
  const lines: unknown = buffer.lines
  if (
    typeof lines !== 'object' ||
    lines === null ||
    !('length' in lines) ||
    !('get' in lines) ||
    !('pop' in lines) ||
    typeof lines.get !== 'function' ||
    typeof lines.pop !== 'function' ||
    typeof buffer.ybase !== 'number' ||
    typeof buffer.y !== 'number' ||
    typeof buffer.x !== 'number'
  ) {
    return null
  }
  const { get, pop } = lines
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0)
  return {
    length: () => num(lines.length),
    line: (index) => get.call(lines, index),
    popLine: () => {
      pop.call(lines)
    },
    ybase: () => num(buffer.ybase),
    y: () => num(buffer.y),
    x: () => num(buffer.x),
    hasScrollRegion: (rows) => num(buffer.scrollTop) !== 0 || num(buffer.scrollBottom) !== rows - 1,
    showOneMoreScrollbackRow: () => {
      const following = buffer.ydisp === buffer.ybase
      buffer.ybase = num(buffer.ybase) - 1
      if (following) {
        buffer.ydisp = buffer.ybase
      }
      buffer.y = num(buffer.y) + 1
      // DECSC's savedY is absolute (ybase + y), so it stays on its text; one saved on the popped
      // row would point past the buffer, so it moves to the new bottom row.
      if ('savedY' in buffer && typeof buffer.savedY === 'number') {
        buffer.savedY = Math.min(buffer.savedY, num(buffer.ybase) + terminal.rows - 1)
      }
    }
  }
}

function isWrapped(line: unknown): boolean {
  return typeof line === 'object' && line !== null && 'isWrapped' in line && line.isWrapped === true
}

// Default colour mode bits of a cell's background (xterm's Attributes.CM_MASK).
const BG_COLOR_MODE_MASK = 0x3000000

/** No text and no background colour: a row ConPTY would not repaint, so dropping it loses nothing. */
function isBlank(line: unknown, cols: number): boolean {
  if (
    typeof line !== 'object' ||
    line === null ||
    !('getTrimmedLength' in line) ||
    typeof line.getTrimmedLength !== 'function' ||
    !('getBg' in line) ||
    typeof line.getBg !== 'function' ||
    isWrapped(line) ||
    line.getTrimmedLength() !== 0
  ) {
    return false
  }
  for (let column = 0; column < cols; column++) {
    if ((line.getBg(column) & BG_COLOR_MODE_MASK) !== 0) {
      return false
    }
  }
  return true
}

/**
 * Resizes as the terminal's PTY does. Unix PTYs follow xterm. ConPTY keeps the line at the top of
 * its viewport through a resize and repaints that viewport from the top, while xterm keeps the
 * cursor's rows in place: a wider grid that rejoins wrapped rows pulls rows back out of scrollback,
 * and a narrower one that rewraps pushes rows into it. ConPTY's repaint then overwrites the pulled
 * rows or repeats the pushed ones, so put the top line back on its row: pulled rows return to
 * scrollback with blank rows below, and pushed rows come back while blank rows below the cursor
 * make room.
 *
 * `writeSync` is null while the parser is inside an escape sequence: writing the correction then
 * would abort the app's sequence, so that resize keeps xterm's own placement.
 */
export function resizeLikeOwnPty(
  terminal: Terminal,
  cols: number,
  rows: number,
  writeSync: ((data: string) => void) | null
): void {
  const conpty = terminal.options.windowsPty?.backend === 'conpty'
  const before = conpty && terminal.buffer.active.type === 'normal' ? liveBuffer(terminal) : null
  // An app's scroll region repaints itself; correcting outside it would move rows it owns.
  if (!before || before.hasScrollRegion(terminal.rows)) {
    terminal.resize(cols, rows)
    return
  }
  // A logical line's first row survives reflow as the same object; continuation rows may not.
  let anchorIndex = before.ybase()
  while (anchorIndex < before.length() - 1 && isWrapped(before.line(anchorIndex))) {
    anchorIndex++
  }
  const anchor = before.line(anchorIndex)
  const anchorRow = anchorIndex - before.ybase()
  terminal.resize(cols, rows)
  const after = liveBuffer(terminal)
  if (!after) {
    return
  }
  let index = -1
  for (let i = 0; i < after.length(); i++) {
    if (after.line(i) === anchor) {
      index = i
      break
    }
  }
  if (index < 0) {
    return
  }
  const shift = index - after.ybase() - anchorRow
  if (shift > 0) {
    if (!writeSync) {
      return
    }
    const cursorRow = Math.max(1, after.y() + 1 - shift)
    writeSync(`\x1b[${rows};1H${'\n'.repeat(shift)}\x1b[${cursorRow};${after.x() + 1}H`)
    return
  }
  for (let pushed = -shift; pushed > 0 && after.ybase() > 0; pushed--) {
    if (after.y() >= rows - 1 || !isBlank(after.line(after.length() - 1), cols)) {
      return
    }
    after.popLine()
    after.showOneMoreScrollbackRow()
  }
}
