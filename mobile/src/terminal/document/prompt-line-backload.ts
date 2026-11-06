import type { TerminalDocumentBuffer } from './document-terminal-shape'

const MAX_WRAPPED_PROMPT_ROWS = 16
const MAX_BACKLOAD_CHARS = 4096

// Ordered from most specific start-of-line TUI/REPL sigils to single-line shell prompts.
const START_OF_LINE_PROMPT_RE = /^\s*(?:[│┃┆▏▎▍▌▋▊▉]\s*)?(?:❯|›|»|λ|>>>|\.\.\.|>|\$|%|#) /
const OMZ_PROMPT_RE = /^\s*➜\s+\S+(?:\s+git:\([^)\r\n]{1,60}\)(?:\s+[✗✘*+])?)? /
const POWERSHELL_PROMPT_RE = /^\s*PS\s+[^\r\n>]{1,100}> /
const SINGLE_LINE_GLYPH_PROMPT_RE = /^[^\r\n]{1,120}?(?:❯|›) /
const POSIX_SHELL_PROMPT_RE =
  /^\s*(?:\([^)\r\n]{1,40}\)\s*)*(?:\[[^\]\r\n]{1,80}\]|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+[^\r\n$%#]{0,80}|~[^\r\n$%#]{0,80}|\/[^\s$%#]{1,80})(?:\s+[^\r\n$%#]{1,60})?\s*(?:\$|%|#) /

const PROMPT_PREFIX_PATTERNS = [
  START_OF_LINE_PROMPT_RE,
  OMZ_PROMPT_RE,
  POWERSHELL_PROMPT_RE,
  SINGLE_LINE_GLYPH_PROMPT_RE,
  POSIX_SHELL_PROMPT_RE
] as const

export function stripPromptPrefix(logicalBeforeCursor: string): string {
  for (const pattern of PROMPT_PREFIX_PATTERNS) {
    const match = pattern.exec(logicalBeforeCursor)
    if (match) {
      return logicalBeforeCursor.slice(match[0].length)
    }
  }
  return ''
}

export function extractActivePromptInputBeforeCursor(
  buffer: TerminalDocumentBuffer | null | undefined
): string {
  if (!buffer || buffer.type !== 'normal') {
    return ''
  }
  const cursorX = buffer.cursorX
  if (typeof cursorX !== 'number' || !Number.isFinite(cursorX) || cursorX <= 0) {
    // Allow wrapped continuations where cursorX === 0 on the continuation row.
    if (cursorX !== 0) {
      return ''
    }
  }
  const cursorAbsRow = (buffer.baseY || 0) + (buffer.cursorY || 0)
  const cursorLine = buffer.getLine(cursorAbsRow)
  if (!cursorLine) {
    return ''
  }

  let startRow = cursorAbsRow
  let wrappedCount = 0
  while (startRow > 0 && wrappedCount < MAX_WRAPPED_PROMPT_ROWS) {
    const current = buffer.getLine(startRow)
    if (!current || !current.isWrapped) {
      break
    }
    startRow -= 1
    wrappedCount += 1
  }

  let logicalBeforeCursor = ''
  for (let row = startRow; row <= cursorAbsRow; row++) {
    const line = buffer.getLine(row)
    if (!line) {
      return ''
    }
    logicalBeforeCursor +=
      row === cursorAbsRow
        ? line.translateToString(false, 0, cursorX)
        : line.translateToString(false)
    if (logicalBeforeCursor.length > MAX_BACKLOAD_CHARS + 256) {
      return ''
    }
  }

  const input = stripPromptPrefix(logicalBeforeCursor)
  if (input.length === 0 || input.length > MAX_BACKLOAD_CHARS) {
    return ''
  }
  return input
}
