import type { Terminal } from '@xterm/headless'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

type TerminalWithOscLinks = Terminal & {
  _core?: {
    _oscLinkService?: {
      getLinkData: (linkId: number) => { uri?: string } | undefined
    }
  }
}

type CellWithOscLink = {
  extended?: { urlId?: number }
  hasExtendedAttrs?: () => boolean
}

export function collectHeadlessOscLinkRanges(
  terminal: Terminal,
  scrollbackRows: number | undefined,
  restoredLinks: TerminalOscLinkRange[] = []
): TerminalOscLinkRange[] {
  // Why: headless xterm exposes OSC 8 metadata only via this private service.
  // Keep this boundary explicit so xterm upgrades are audited here.
  const service = (terminal as TerminalWithOscLinks)._core?._oscLinkService
  if (!service) {
    return []
  }
  const buffer = terminal.buffer.active
  const startRow =
    scrollbackRows === undefined ? 0 : Math.max(0, buffer.length - terminal.rows - scrollbackRows)
  const ranges: TerminalOscLinkRange[] = []
  for (let row = startRow; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)
    if (!line) {
      continue
    }
    const lineLength = Math.min(terminal.cols, line.length)
    let currentUrlId = 0
    let currentStart = -1
    for (let col = 0; col <= lineLength; col += 1) {
      const urlId = col < lineLength ? getOscLinkIdAtCell(line, col) : 0
      if (urlId === currentUrlId) {
        continue
      }
      if (currentUrlId && currentStart >= 0) {
        const uri = service.getLinkData(currentUrlId)?.uri
        if (uri) {
          ranges.push({ row: row - startRow, startCol: currentStart, endCol: col, uri })
        }
      }
      currentUrlId = urlId
      currentStart = urlId ? col : -1
    }
  }
  for (const link of restoredLinks) {
    if (link.row < startRow || link.row >= buffer.length) {
      continue
    }
    const startCol = Math.max(0, Math.min(terminal.cols, link.startCol))
    const endCol = Math.max(0, Math.min(terminal.cols, link.endCol))
    if (startCol >= endCol) {
      continue
    }
    ranges.push({
      row: link.row - startRow,
      startCol,
      endCol,
      uri: link.uri
    })
  }
  return dedupeOscLinkRanges(ranges)
}

function dedupeOscLinkRanges(ranges: TerminalOscLinkRange[]): TerminalOscLinkRange[] {
  const seen = new Set<string>()
  return ranges.filter((range) => {
    const key = `${range.row}:${range.startCol}:${range.endCol}:${range.uri}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function getOscLinkIdAtCell(line: { getCell: (col: number) => unknown }, col: number): number {
  const cell = line.getCell(col) as CellWithOscLink | undefined
  // Why: OSC link IDs live in extended cell attrs; missing attrs means no link.
  return cell?.hasExtendedAttrs?.() && cell.extended?.urlId ? cell.extended.urlId : 0
}
