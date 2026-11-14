export type MobileFilePreviewLineColumn = {
  line: number
  column: number | null
}

const MOBILE_FILE_PREVIEW_TEXT_LINE_HEIGHT = 19

export function normalizeMobileFilePreviewLineColumn(
  line: string | undefined,
  column: string | undefined
): MobileFilePreviewLineColumn | null {
  const normalizedLine = parsePositiveInteger(line)
  if (normalizedLine === null) {
    return null
  }
  return {
    line: normalizedLine,
    column: parsePositiveInteger(column)
  }
}

export function textOffsetForLineColumn(
  content: string,
  target: MobileFilePreviewLineColumn
): number {
  let lineStart = 0
  for (let currentLine = 1; currentLine < target.line; currentLine += 1) {
    const nextBreak = content.indexOf('\n', lineStart)
    if (nextBreak === -1) {
      return content.length
    }
    lineStart = nextBreak + 1
  }

  const lineEnd = content.indexOf('\n', lineStart)
  const cappedLineEnd = lineEnd === -1 ? content.length : lineEnd
  const columnOffset = Math.max(0, (target.column ?? 1) - 1)
  return Math.min(cappedLineEnd, lineStart + columnOffset)
}

export function scrollOffsetForPreviewLine(line: number): number {
  return Math.max(0, line - 1) * MOBILE_FILE_PREVIEW_TEXT_LINE_HEIGHT
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}
