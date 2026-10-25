import { PROSE_HTTP_URL_SOURCE } from '../../../src/shared/prose-url-boundary'

export { resolveTerminalFileUrlTap, resolveTerminalOscFileTap } from './terminal-file-url-tap'

export const TERMINAL_HTTP_URL_REGEX_SOURCE = String.raw`\b${PROSE_HTTP_URL_SOURCE}`
export const TERMINAL_FILE_URL_REGEX_SOURCE =
  String.raw`\bfile:\/\/[^\s"'!*(){}|\\^<>` +
  '`' +
  String.raw`]*[^\s"',!?{}|\\^~[\]` +
  '`' +
  String.raw`()<>]`
export const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

export function findUrlAtColumn(lineText: string, col: number): string | null {
  return findTerminalUrlAtColumn(lineText, col, TERMINAL_HTTP_URL_REGEX_SOURCE)
}

export function findFileUrlAtColumn(lineText: string, col: number): string | null {
  return findTerminalUrlAtColumn(lineText, col, TERMINAL_FILE_URL_REGEX_SOURCE)
}

function findTerminalUrlAtColumn(lineText: string, col: number, source: string): string | null {
  if (typeof lineText !== 'string' || lineText.length === 0) {
    return null
  }
  const re = new RegExp(source, 'giu')
  let match: RegExpExecArray | null
  while ((match = re.exec(lineText)) !== null) {
    const start = match.index
    const end = start + match[0].length
    // Match desktop’s maximum URL length before opening terminal candidates.
    if (match[0].length <= TERMINAL_HTTP_URL_MAX_LENGTH && col >= start && col < end) {
      return match[0]
    }
    // Guard against empty regex matches to prevent a future pattern change from looping forever.
    if (match[0].length === 0) {
      re.lastIndex++
    }
  }
  return null
}
