import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

type TerminalWithOscLinks = Terminal & {
  _core?: {
    _oscLinkService?: {
      getLinkData: (linkId: number) => { uri?: string } | undefined
      // Why read it: xterm registers every OSC 8 id here, so an empty registry
      // proves the buffer holds no hyperlink and the per-cell scan can be skipped.
      // Optional because it is private — an xterm that renames it just scans.
      _dataByLinkId?: { size?: number }
    }
  }
}

type CellWithOscLink = {
  extended?: { urlId?: number }
  hasExtendedAttrs?: () => boolean
}

/** True when xterm holds no OSC 8 registration at all, so no cell can carry one. */
function hasNoRegisteredOscLinks(service: { _dataByLinkId?: { size?: number } }): boolean {
  return service._dataByLinkId?.size === 0
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
  // Why before the scan: the walk below reads every cell of every row, and a
  // session that never emitted a hyperlink — the overwhelming majority — would
  // pay that for a guaranteed-empty result. `restoredLinks` still needs mapping.
  if (hasNoRegisteredOscLinks(service) && restoredLinks.length === 0) {
    return []
  }
  const startRow =
    scrollbackRows === undefined ? 0 : Math.max(0, buffer.length - terminal.rows - scrollbackRows)
  const ranges: TerminalOscLinkRange[] = []
  // Why one cell for the whole walk: xterm's getCell allocates a fresh CellData
  // per call unless handed a target, which is a per-cell allocation across the
  // entire scrollback. See the IBufferLine.getCell docs.
  const scratchCell = buffer.getNullCell()
  for (let row = startRow; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)
    if (!line) {
      continue
    }
    const lineLength = Math.min(terminal.cols, line.length)
    let currentUrlId = 0
    let currentStart = -1
    for (let col = 0; col <= lineLength; col += 1) {
      const urlId = col < lineLength ? getOscLinkIdAtCell(line, col, scratchCell) : 0
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

function getOscLinkIdAtCell(line: IBufferLine, col: number, scratchCell: IBufferCell): number {
  const cell = line.getCell(col, scratchCell) as (IBufferCell & CellWithOscLink) | undefined
  // Why: OSC link IDs live in extended cell attrs; missing attrs means no link.
  return cell?.hasExtendedAttrs?.() && cell.extended?.urlId ? cell.extended.urlId : 0
}
