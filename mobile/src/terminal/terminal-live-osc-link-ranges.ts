import type { Terminal } from '@xterm/xterm'
import type { TerminalOscLinkRange } from '../../../src/shared/terminal-osc-link-ranges'

export type RetainedTerminalOscLinkRange = TerminalOscLinkRange & {
  expectedText: string
}

type TerminalCursor = {
  row: number
  column: number
  columns: number
}

const MAX_LIVE_OSC_LINKS = 256
const MAX_OSC_LINK_URI_LENGTH = 2_048
const MAX_OSC_LINK_ROW_SPAN = 64

export function createTerminalLiveOscLinkRanges(terminal: Terminal) {
  const tracker = createTerminalLiveOscLinkTracker()
  let bufferType = terminal.buffer.active.type
  let retained: RetainedTerminalOscLinkRange[] = []
  const handler = terminal.parser.registerOscHandler(8, (data) => {
    resetForBufferChange()
    const buffer = terminal.buffer.active
    const completed = tracker.handle(data, {
      row: buffer.baseY + buffer.cursorY,
      column: buffer.cursorX,
      columns: terminal.cols
    })
    for (const link of completed) {
      const text = buffer.getLine(link.row)?.translateToString(false, link.startCol, link.endCol)
      if (text) {
        retained.push({ ...link, expectedText: text })
      }
    }
    retained = retained.slice(-MAX_LIVE_OSC_LINKS)
    return false
  })

  const resetForBufferChange = () => {
    if (bufferType === terminal.buffer.active.type) {
      return
    }
    bufferType = terminal.buffer.active.type
    tracker.reset()
    retained = []
  }

  return {
    ranges() {
      resetForBufferChange()
      return retained
    },
    trimLeadingRow() {
      resetForBufferChange()
      tracker.trimLeadingRow()
      retained = retained
        .filter((link) => link.row > 0)
        .map((link) => ({ ...link, row: link.row - 1 }))
    },
    reset() {
      bufferType = terminal.buffer.active.type
      tracker.reset()
      retained = []
    },
    dispose() {
      handler.dispose()
    }
  }
}

export function createTerminalLiveOscLinkTracker() {
  let active: { uri: string; row: number; startCol: number } | null = null
  return {
    handle(data: string, cursor: TerminalCursor): TerminalOscLinkRange[] {
      const separator = data.indexOf(';')
      if (separator === -1 || data.length > MAX_OSC_LINK_URI_LENGTH + 256 || !validCursor(cursor)) {
        active = null
        return []
      }
      const uri = data.slice(separator + 1)
      if (uri) {
        active =
          uri.length <= MAX_OSC_LINK_URI_LENGTH
            ? { uri, row: cursor.row, startCol: cursor.column }
            : null
        return []
      }
      if (!active) {
        return []
      }
      const completed = rangesBetween(active, cursor)
      active = null
      return completed
    },
    trimLeadingRow() {
      active = active && active.row > 0 ? { ...active, row: active.row - 1 } : null
    },
    reset() {
      active = null
    }
  }
}

function rangesBetween(
  start: { uri: string; row: number; startCol: number },
  end: TerminalCursor
): TerminalOscLinkRange[] {
  const rowSpan = end.row - start.row
  if (rowSpan < 0 || rowSpan > MAX_OSC_LINK_ROW_SPAN) {
    return []
  }
  if (rowSpan === 0) {
    return start.startCol < end.column
      ? [{ row: start.row, startCol: start.startCol, endCol: end.column, uri: start.uri }]
      : []
  }
  const ranges: TerminalOscLinkRange[] = []
  if (start.startCol < end.columns) {
    ranges.push({
      row: start.row,
      startCol: start.startCol,
      endCol: end.columns,
      uri: start.uri
    })
  }
  for (let row = start.row + 1; row < end.row; row += 1) {
    ranges.push({ row, startCol: 0, endCol: end.columns, uri: start.uri })
  }
  if (end.column > 0) {
    ranges.push({ row: end.row, startCol: 0, endCol: end.column, uri: start.uri })
  }
  return ranges
}

function validCursor(cursor: TerminalCursor): boolean {
  return (
    Number.isInteger(cursor.row) &&
    cursor.row >= 0 &&
    Number.isInteger(cursor.column) &&
    cursor.column >= 0 &&
    Number.isInteger(cursor.columns) &&
    cursor.columns > 0 &&
    cursor.column <= cursor.columns
  )
}
