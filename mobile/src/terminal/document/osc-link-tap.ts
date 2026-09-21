import { cellColToStringIndex, getLineText } from './cell-geometry'
import { viewportToCell } from './viewport-cell'
import {
  scope,
  type TerminalDocumentLine,
  type TerminalInitialOscLink,
  type TerminalOscLinkService
} from './document-scope'
import { parsePathLineCol, type TerminalPathCandidate } from './path-tap'

/** What a tapped OSC 8 link resolves to: a URL to open, or a file to reveal. */
export type TerminalOscLinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'file'; fileTap: TerminalPathCandidate }

// Why: OSC 8 links can render as labels like "#1234"; the URI lives in
// xterm's internal link service, so every access is guarded and falls through.
export function oscLinkService(): TerminalOscLinkService | null {
  try {
    const core = scope.term && scope.term._core
    if (!core) {
      return null
    }
    return (
      core._oscLinkService || (core._inputHandler && core._inputHandler._oscLinkService) || null
    )
  } catch {
    return null
  }
}

export function oscLinkAtViewportPoint(clientX: number, clientY: number) {
  try {
    const cell = viewportToCell(clientX, clientY)
    if (!cell) {
      return null
    }
    const line = scope.term!.buffer.active.getLine(cell.row)
    if (!line) {
      return null
    }
    const urlId = oscLinkIdAtCell(line, cell.col)
    if (!urlId) {
      return initialOscLinkAtCell(cell.row, cell.col)
    }
    const svc = oscLinkService()
    if (!svc || !svc.getLinkData) {
      return initialOscLinkAtCell(cell.row, cell.col)
    }
    const data = svc.getLinkData(urlId)
    const uri = data && data.uri
    return terminalOscLinkTarget(uri)
  } catch {
    return null
  }
}

export function initialOscLinkAtCell(row: number, col: number) {
  for (let i = 0; i < scope.initialOscLinks.length; i++) {
    const link = scope.initialOscLinks[i]
    if (!link || typeof link.uri !== 'string') {
      continue
    }
    if (link.row < scope.initialOscLinkRowOffset) {
      continue
    }
    const shiftedRow = link.row - scope.initialOscLinkRowOffset
    if (
      shiftedRow === row &&
      col >= link.startCol &&
      col < link.endCol &&
      initialOscLinkTextStillMatches(link, shiftedRow)
    ) {
      return terminalOscLinkTarget(link.uri)
    }
  }
  return null
}

export function terminalOscLinkTarget(uri: unknown): TerminalOscLinkTarget | null {
  if (typeof uri !== 'string') {
    return null
  }
  if (/^https?:/i.test(uri)) {
    return { kind: 'url', url: uri }
  }
  const fileTap = resolveTerminalOscFileTap(uri)
  return fileTap ? { kind: 'file', fileTap: fileTap } : null
}

export function resolveTerminalOscFileTap(uri: string) {
  return resolveTerminalFileUrlTap(uri) || parseOscPathLikeTarget(uri)
}

export function resolveTerminalFileUrlTap(uri: string): TerminalPathCandidate | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') {
    return null
  }
  let filePath: string
  try {
    filePath = decodeURIComponent(parsed.pathname || '')
  } catch {
    return null
  }
  if (parsed.hostname && !isLocalFileUriHostname(parsed.hostname)) {
    filePath = '//' + parsed.hostname + filePath
  } else if (/^\/[A-Za-z]:\//.test(filePath)) {
    filePath = filePath.slice(1)
  }
  if (!filePath) {
    return null
  }
  const hashTarget = parseFileUrlLineHash(parsed.hash || '')
  if (hashTarget) {
    return { pathText: filePath, line: hashTarget.line, column: hashTarget.column }
  }
  if (/%3a/i.test(parsed.pathname || '')) {
    return { pathText: filePath, line: null, column: null }
  }
  return (
    parseFilePathTrailingLineTarget(filePath) || { pathText: filePath, line: null, column: null }
  )
}

export function isLocalFileUriHostname(hostname: string) {
  const normalized = String(hostname).toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  )
}

export function parseOscPathLikeTarget(value: string) {
  if (
    !/^(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))/.test(
      value
    )
  ) {
    return null
  }
  return parsePathLineCol(value)
}

export function parseFileUrlLineHash(hash: string) {
  const match = /^#?L(\d+)(?:C(\d+))?$/i.exec(hash)
  if (!match) {
    return null
  }
  const line = Number.parseInt(match[1], 10)
  const column = match[2] ? Number.parseInt(match[2], 10) : null
  if (line < 1 || (column !== null && column < 1)) {
    return null
  }
  return { line: line, column: column }
}

export function parseFilePathTrailingLineTarget(filePath: string) {
  const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(filePath)
  if (
    !match ||
    !match[1] ||
    match[1].charAt(match[1].length - 1) === '/' ||
    match[1].charAt(match[1].length - 1) === '\\'
  ) {
    return null
  }
  const line = Number.parseInt(match[2], 10)
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if (line < 1 || (column !== null && column < 1)) {
    return null
  }
  return { pathText: match[1], line: line, column: column }
}

export function captureInitialOscLinkTexts() {
  if (!Array.isArray(scope.initialOscLinks)) {
    return
  }
  for (let i = 0; i < scope.initialOscLinks.length; i++) {
    const link = scope.initialOscLinks[i]
    if (!link || typeof link.text === 'string') {
      continue
    }
    link.text = initialOscLinkTextAtRow(link, link.row)
  }
}

export function initialOscLinkTextStillMatches(link: TerminalInitialOscLink, row: number) {
  if (typeof link.text !== 'string') {
    return false
  }
  return link.text.length > 0 && initialOscLinkTextAtRow(link, row) === link.text
}

export function initialOscLinkTextAtRow(link: TerminalInitialOscLink, row: number) {
  try {
    const lineText = getLineText(row)
    const start = cellColToStringIndex(row, link.startCol)
    const end = cellColToStringIndex(row, link.endCol)
    return lineText.slice(start, end)
  } catch {
    return ''
  }
}

export function oscLinkIdAtCell(line: TerminalDocumentLine, col: number) {
  try {
    const bufCell = line.getCell!(col)
    return bufCell && bufCell.extended && bufCell.extended.urlId ? bufCell.extended.urlId : 0
  } catch {
    return 0
  }
}
