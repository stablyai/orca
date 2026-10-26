import {
  parseFileLinkLocation,
  type ParsedFileLinkLocation
} from '../../../src/shared/file-link-location'
import {
  matchFilePathAtColumn as documentMatchFilePathAtColumn,
  matchWrappedFilePathAtRowColumn as documentMatchWrappedFilePathAtRowColumn,
  type TerminalWrappedLineRow
} from './document/path-tap'

export type TappedFilePath = ParsedFileLinkLocation
export type { TerminalWrappedLineRow }

export function parsePathWithOptionalLineColumn(value: string): TappedFilePath | null {
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const { pathText, line, column } = parsed
  if (pathText.endsWith('/') || pathText.endsWith('\\')) {
    return null
  }
  return { pathText, line, column }
}

export function matchWrappedFilePathAtRowColumn(
  rows: readonly TerminalWrappedLineRow[],
  tappedRowIndex: number,
  tappedCol: number,
  terminalCols?: number
): TappedFilePath | null {
  return documentMatchWrappedFilePathAtRowColumn(rows, tappedRowIndex, tappedCol, terminalCols)
}

export function matchFilePathAtColumn(lineText: string, col: number): TappedFilePath | null {
  return documentMatchFilePathAtColumn(lineText, col)
}
