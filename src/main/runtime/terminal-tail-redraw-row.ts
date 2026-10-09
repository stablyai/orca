import { ownRetainedString } from '../../shared/own-retained-string'

// Flat-string rows: one splice per written run, which V8 flattens with a memcpy. The caches let a
// row the cursor only revisits, or rewrites with identical text, skip its newline snapshot.
export type RetainedTerminalRow = {
  text: string
  /** Right-trimmed snapshot; null after a content change. */
  snapshot: string | null
  /** Index after the last non-space/tab, or -1 when unknown. */
  contentEnd: number
  /** Lower bound on the all-space prefix, so a repeated erase-to-start is a no-op. */
  blankPrefix: number
  /** Upper bound on the backing string `text` may slice; 0 when `text` owns its storage. */
  backing: number
  completed: boolean
}

export function retainedRow(text: string, completed: boolean): RetainedTerminalRow {
  // A carried row may be a snapshot that slices up to twice its length.
  return {
    text,
    snapshot: null,
    contentEnd: -1,
    blankPrefix: 0,
    backing: 2 * text.length,
    completed
  }
}

function isTrimmedWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09
}

/** Write source[start, end) at `column`; identical characters leave the row clean. */
export function writeRetainedRow(
  row: RetainedTerminalRow,
  column: number,
  source: string,
  start: number,
  end: number
): void {
  const text = row.text
  const runLength = end - start
  const overlap = Math.max(0, Math.min(text.length - column, runLength))
  let offset = 0
  while (
    offset < overlap &&
    text.charCodeAt(column + offset) === source.charCodeAt(start + offset)
  ) {
    offset += 1
  }
  if (offset === runLength) {
    return
  }
  // Why own: the row can outlive this chunk as a tail line, and a long run is a slice of it.
  if (column === 0 && runLength >= text.length) {
    row.text = ownRetainedString(source.slice(start, end))
    row.backing = 0
  } else if (column >= text.length) {
    const gap = column - text.length
    const run = ownRetainedString(source.slice(start, end))
    row.text = gap > 0 ? `${text}${' '.repeat(gap)}${run}` : `${text}${run}`
  } else {
    // Skip the identical prefix so a write past the row end can append instead of splicing.
    const at = column + offset
    const run = ownRetainedString(source.slice(start + offset, end))
    if (offset === overlap) {
      row.text = `${text}${run}`
    } else {
      row.text = `${text.slice(0, at)}${run}${text.slice(column + runLength)}`
      row.backing = Math.max(row.backing, text.length)
    }
  }
  noteWrite(row, column, column + runLength, writtenEnd(column, source, start, end))
}

function writtenEnd(column: number, source: string, start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    if (!isTrimmedWhitespace(source.charCodeAt(index))) {
      return column + index + 1 - start
    }
  }
  return -1
}

/** Note a content-changing write of [column, runEnd) whose last non-whitespace ends at `written`. */
function noteWrite(
  row: RetainedTerminalRow,
  column: number,
  runEnd: number,
  written: number
): void {
  row.snapshot = null
  row.blankPrefix = Math.min(row.blankPrefix, column)
  const contentEnd = row.contentEnd
  if (contentEnd > runEnd) {
    return
  }
  if (contentEnd === -1) {
    // Unknown content may survive past the run.
    row.contentEnd = runEnd >= row.text.length ? written : -1
  } else if (written !== -1) {
    row.contentEnd = written
  } else if (contentEnd > column) {
    row.contentEnd = -1
  }
}

/** CSI K in modes 0/1/2 at `column`; other modes are no-ops. */
export function eraseRetainedRow(row: RetainedTerminalRow, mode: number, column: number): void {
  const text = row.text
  if (mode === 2 || mode === 0) {
    const keep = mode === 2 ? 0 : column
    if (keep >= text.length) {
      return
    }
    row.text = keep === 0 ? '' : text.slice(0, keep)
    row.backing = keep === 0 ? 0 : Math.max(row.backing, text.length)
    ownShrunkText(row)
    row.snapshot = null
    row.blankPrefix = Math.min(row.blankPrefix, keep)
    if (row.contentEnd > keep) {
      row.contentEnd = -1
    }
    return
  }
  if (mode !== 1) {
    return
  }
  const blankCount = Math.min(column + 1, text.length)
  let firstNonBlank = row.blankPrefix
  while (firstNonBlank < blankCount && text.charCodeAt(firstNonBlank) === 0x20) {
    firstNonBlank += 1
  }
  row.blankPrefix = Math.max(row.blankPrefix, blankCount)
  if (firstNonBlank >= blankCount) {
    return
  }
  row.text = `${' '.repeat(blankCount)}${text.slice(blankCount)}`
  row.backing = Math.max(row.backing, text.length)
  row.snapshot = null
  if (row.contentEnd !== -1 && row.contentEnd <= blankCount) {
    row.contentEnd = 0
  }
}

/** The right-trimmed row text; rebuilt only after a content change. */
export function retainedRowSnapshot(row: RetainedTerminalRow): string {
  if (row.snapshot !== null) {
    return row.snapshot
  }
  const text = row.text
  let end = row.contentEnd
  if (end === -1) {
    end = text.length
    while (end > 0 && isTrimmedWhitespace(text.charCodeAt(end - 1))) {
      end -= 1
    }
    row.contentEnd = end
  }
  if (end === text.length) {
    ownShrunkText(row)
    row.snapshot = row.text
  } else {
    // Why own a short trim: the slice would otherwise pin the whole padded row while retained.
    const backing = Math.max(row.backing, text.length)
    row.snapshot = end * 2 < backing ? ownRetainedString(text.slice(0, end)) : text.slice(0, end)
  }
  return row.snapshot
}

// Why cumulative: a chain of erases that each keep half the row never crosses a per-erase
// threshold, yet nested slices still pin the original row.
function ownShrunkText(row: RetainedTerminalRow): void {
  if (row.backing > 2 * row.text.length) {
    row.text = ownRetainedString(row.text)
    row.backing = 0
  }
}
