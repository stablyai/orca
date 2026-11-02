import type {
  RuntimeTerminalRead,
  RuntimeTerminalRowMetadata
} from '../../../shared/runtime-terminal-contracts'

const DISPATCH_CAPABILITY_PATTERN = /\bdcap_[A-Za-z0-9_-]{20,}\b/g
const DISPATCH_CAPABILITY_REDACTION = '[dispatch capability redacted]'
const TERMINAL_REDACTION_WARNING = 'Dispatch capability tokens were redacted from terminal output.'
const WRAP_COVERAGE_WARNING =
  'Terminal wrap information was unavailable; capability masking used complete lines.'

export function replaceDispatchCapabilities(value: string): { value: string; redacted: boolean } {
  DISPATCH_CAPABILITY_PATTERN.lastIndex = 0
  const redacted = DISPATCH_CAPABILITY_PATTERN.test(value)
  DISPATCH_CAPABILITY_PATTERN.lastIndex = 0
  return {
    value: redacted
      ? value.replace(DISPATCH_CAPABILITY_PATTERN, DISPATCH_CAPABILITY_REDACTION)
      : value,
    redacted
  }
}

function validRows(
  lines: readonly string[],
  rows: readonly RuntimeTerminalRowMetadata[] | undefined
): rows is readonly RuntimeTerminalRowMetadata[] {
  return (
    Array.isArray(rows) &&
    rows.length === lines.length &&
    rows.every(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        typeof row.wrapped === 'boolean' &&
        Number.isSafeInteger(row.trailingSpaces) &&
        row.trailingSpaces >= 0
    )
  )
}

type RowSpan = { row: number; start: number; end: number }
type RowEdit = { start: number; end: number; replacement: string }

function redactLogicalRows(lines: readonly string[], rows: readonly RuntimeTerminalRowMetadata[]) {
  const edits: RowEdit[][] = lines.map(() => [])
  const parts: string[] = []
  const spans: RowSpan[] = []
  let offset = 0
  let redacted = false
  function flush(): void {
    let spanIndex = 0
    for (const match of parts.join('').matchAll(DISPATCH_CAPABILITY_PATTERN)) {
      if (match.index === undefined) {
        continue
      }
      redacted = true
      const start = match.index
      const end = start + match[0].length
      while (spanIndex < spans.length && spans[spanIndex].end <= start) {
        spanIndex += 1
      }
      let cursor = spanIndex
      while (cursor < spans.length && spans[cursor].start < end) {
        const span = spans[cursor]
        const from = Math.max(start, span.start)
        const to = Math.min(end, span.end)
        if (from < to) {
          edits[span.row].push({
            start: from - span.start,
            end: to - span.start,
            replacement: start >= span.start ? DISPATCH_CAPABILITY_REDACTION : ''
          })
        }
        cursor += 1
      }
    }
    parts.length = 0
    spans.length = 0
    offset = 0
  }
  lines.forEach((line, row) => {
    if (row > 0 && !rows[row].wrapped) {
      flush()
    }
    spans.push({ row, start: offset, end: offset + line.length })
    parts.push(line)
    offset += line.length
    // One space preserves the token boundary without allocating host-reported padding.
    if (rows[row].trailingSpaces > 0) {
      parts.push(' ')
      offset += 1
    }
  })
  flush()
  return {
    lines: lines.map((line, row) => {
      const pieces: string[] = []
      let cursor = 0
      for (const edit of edits[row]) {
        pieces.push(line.slice(cursor, edit.start), edit.replacement)
        cursor = edit.end
      }
      pieces.push(line.slice(cursor))
      return pieces.join('')
    }),
    redacted
  }
}

export function redactWorkerTerminalLines(
  lines: readonly string[],
  rows?: readonly RuntimeTerminalRowMetadata[]
): { lines: string[]; warnings: string[] } {
  let redacted = false
  let output: string[]
  if (validRows(lines, rows)) {
    const result = redactLogicalRows(lines, rows)
    output = result.lines
    redacted = result.redacted
  } else {
    output = lines.map((line) => {
      const result = replaceDispatchCapabilities(line)
      redacted ||= result.redacted
      return result.value
    })
  }
  return { lines: output, warnings: redacted ? [TERMINAL_REDACTION_WARNING] : [] }
}

export function redactWorkerTerminalView(
  terminal: Pick<RuntimeTerminalRead, 'tail' | 'tailRows' | 'draft' | 'source'>
): { tail: string[]; draft?: string; warnings: string[] } {
  const tail = redactWorkerTerminalLines(terminal.tail, terminal.tailRows)
  const draft =
    terminal.draft === undefined ? undefined : replaceDispatchCapabilities(terminal.draft)
  return {
    tail: tail.lines,
    ...(draft ? { draft: draft.value } : {}),
    warnings: [
      ...new Set([
        ...tail.warnings,
        ...(draft?.redacted ? [TERMINAL_REDACTION_WARNING] : []),
        ...((terminal.source === 'screen' || terminal.source === undefined) &&
        terminal.tail.length > 0 &&
        !validRows(terminal.tail, terminal.tailRows)
          ? [WRAP_COVERAGE_WARNING]
          : [])
      ])
    ]
  }
}
