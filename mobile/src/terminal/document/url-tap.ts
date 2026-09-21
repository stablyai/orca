import { cellColToStringIndex, getLineText } from './cell-geometry'
import { viewportToCell } from './viewport-cell'
import {
  terminalFileUrlRegexSource,
  terminalHttpUrlMaxLength,
  terminalHttpUrlRegexSource
} from './document-constants'

const URL_TAP_RE_SOURCE = terminalHttpUrlRegexSource
const FILE_URL_TAP_RE_SOURCE = terminalFileUrlRegexSource
const URL_TAP_MAX_LENGTH = terminalHttpUrlMaxLength

export function findUrlAtColumn(lineText: string, col: number) {
  return findTerminalUrlAtColumn(lineText, col, URL_TAP_RE_SOURCE)
}

export function findFileUrlAtColumn(lineText: string, col: number) {
  return findTerminalUrlAtColumn(lineText, col, FILE_URL_TAP_RE_SOURCE)
}

export function findTerminalUrlAtColumn(lineText: unknown, col: number, source: string) {
  if (typeof lineText !== 'string' || lineText.length === 0) {
    return null
  }
  const re = new RegExp(source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(lineText)) !== null) {
    const end = match.index + match[0].length
    if (match[0].length <= URL_TAP_MAX_LENGTH && col >= match.index && col < end) {
      return match[0]
    }
    if (match[0].length === 0) {
      re.lastIndex++
    }
  }
  return null
}

export function fileUrlAtViewportPoint(clientX: number, clientY: number) {
  const cell = viewportToCell(clientX, clientY)
  if (!cell) {
    return null
  }
  return findFileUrlAtColumn(getLineText(cell.row), cellColToStringIndex(cell.row, cell.col))
}

export function urlAtViewportPoint(clientX: number, clientY: number) {
  const cell = viewportToCell(clientX, clientY)
  if (!cell) {
    return null
  }
  // Map the cell column to a string index so wide chars earlier on the line
  // don't shift the match column off the tapped URL.
  return findUrlAtColumn(getLineText(cell.row), cellColToStringIndex(cell.row, cell.col))
}
