import type { TerminalDocumentScope } from './document-scope'
import { cellColToStringIndex, getLineText } from './cell-geometry'
import { viewportToCell } from './viewport-cell'
import {
  TERMINAL_FILE_URL_REGEX_SOURCE,
  TERMINAL_HTTP_URL_MAX_LENGTH,
  TERMINAL_HTTP_URL_REGEX_SOURCE
} from '../terminal-webview-url-tap'

export function findUrlAtColumn(lineText: string, col: number) {
  return findTerminalUrlAtColumn(lineText, col, TERMINAL_HTTP_URL_REGEX_SOURCE)
}

export function findFileUrlAtColumn(lineText: string, col: number) {
  return findTerminalUrlAtColumn(lineText, col, TERMINAL_FILE_URL_REGEX_SOURCE)
}

export function findTerminalUrlAtColumn(lineText: unknown, col: number, source: string) {
  if (typeof lineText !== 'string' || lineText.length === 0) {
    return null
  }
  const re = new RegExp(source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(lineText)) !== null) {
    const end = match.index + match[0].length
    if (match[0].length <= TERMINAL_HTTP_URL_MAX_LENGTH && col >= match.index && col < end) {
      return match[0]
    }
    if (match[0].length === 0) {
      re.lastIndex++
    }
  }
  return null
}

export function fileUrlAtViewportPoint(
  scope: TerminalDocumentScope,
  clientX: number,
  clientY: number
) {
  const cell = viewportToCell(scope, clientX, clientY)
  if (!cell) {
    return null
  }
  return findFileUrlAtColumn(
    getLineText(scope, cell.row),
    cellColToStringIndex(scope, cell.row, cell.col)
  )
}

export function urlAtViewportPoint(scope: TerminalDocumentScope, clientX: number, clientY: number) {
  const cell = viewportToCell(scope, clientX, clientY)
  if (!cell) {
    return null
  }
  // Map the cell column to a string index so wide chars earlier on the line
  // don't shift the match column off the tapped URL.
  return findUrlAtColumn(
    getLineText(scope, cell.row),
    cellColToStringIndex(scope, cell.row, cell.col)
  )
}
