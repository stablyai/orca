import type { MobileDiffLine } from './mobile-diff-lines'
import type { MobileDiffReviewThread } from '../diff-actions/mobile-diff-review-github'

// Monaco's hideUnchangedRegions defaults, which desktop's diff uses: 3 lines of context each side, fold 3 or more.
const CONTEXT_LINES = 3
const MINIMUM_FOLDED_LINES = 3

export type MobileDiffReviewRow<Line extends MobileDiffLine = MobileDiffLine> =
  | { kind: 'line'; key: string; line: Line; lineIndex: number }
  | {
      kind: 'fold'
      key: string
      hiddenCount: number
      startIndex: number
      endIndex: number
      /** The line the folded code sits inside, shown on the fold like GitHub's hunk header. */
      enclosingLine: string | null
    }
  | { kind: 'thread'; key: string; thread: MobileDiffReviewThread }

/**
 * Unchanged runs fold into one row each. Lines the reader opened stay open even when a later
 * note splits their run, and annotated lines never fold.
 */
export function buildMobileDiffReviewRows<Line extends MobileDiffLine>(
  lines: readonly Line[],
  openedLineIndexes: ReadonlySet<number>,
  annotatedLineNumbers: ReadonlySet<number> = new Set(),
  /** GitHub threads by the new-side line they end on; each renders under that line. */
  threadsByLine: ReadonlyMap<number, readonly MobileDiffReviewThread[]> = new Map()
): MobileDiffReviewRow<Line>[] {
  // A note on an unchanged line anchors it like a change, so the note is never hidden in a fold.
  const foldable = (lineIndex: number) => {
    const line = lines[lineIndex]
    return (
      line?.kind === 'context' &&
      !openedLineIndexes.has(lineIndex) &&
      (line.newLineNumber === undefined ||
        (!annotatedLineNumbers.has(line.newLineNumber) && !threadsByLine.has(line.newLineNumber)))
    )
  }
  const rows: MobileDiffReviewRow<Line>[] = []
  const pushLine = (lineIndex: number) => {
    const line = lines[lineIndex]
    if (!line) {
      return
    }
    rows.push({ kind: 'line', key: `line:${lineIndex}`, line, lineIndex })
    // Threads sit on the new side, so a deleted line never carries one.
    const threads =
      line.kind !== 'delete' && line.newLineNumber !== undefined
        ? threadsByLine.get(line.newLineNumber)
        : undefined
    for (const thread of threads ?? []) {
      rows.push({ kind: 'thread', key: `thread:${thread.threadId}`, thread })
    }
  }
  let index = 0
  while (index < lines.length) {
    if (!foldable(index)) {
      pushLine(index)
      index += 1
      continue
    }
    const runStart = index
    while (index < lines.length && foldable(index)) {
      index += 1
    }
    const runEnd = index
    // A run touching the file's start or end has no change on that side to keep context for.
    const keepBefore = runStart === 0 ? 0 : CONTEXT_LINES
    const keepAfter = runEnd === lines.length ? 0 : CONTEXT_LINES
    const foldStart = runStart + keepBefore
    const foldEnd = runEnd - keepAfter
    const folds = foldEnd - foldStart >= MINIMUM_FOLDED_LINES
    for (let lineIndex = runStart; lineIndex < runEnd; lineIndex += 1) {
      if (folds && lineIndex === foldStart) {
        rows.push({
          kind: 'fold',
          key: `fold:${foldStart}`,
          hiddenCount: foldEnd - foldStart,
          startIndex: foldStart,
          endIndex: foldEnd,
          enclosingLine: foldEnclosingLine(lines, foldEnd)
        })
        lineIndex = foldEnd - 1
        continue
      }
      pushLine(lineIndex)
    }
  }
  return rows
}

const TAB_COLUMNS = 4

function indentColumns(text: string): number {
  let columns = 0
  for (const char of text) {
    if (char === ' ') {
      columns += 1
    } else if (char === '\t') {
      columns += TAB_COLUMNS
    } else {
      break
    }
  }
  return columns
}

/**
 * The phone's diff has no `@@` headers, so the fold names its scope itself: the nearest new-file line at or
 * above the fold's end that is indented less than the first line shown after it. Blank lines don't count.
 */
export function foldEnclosingLine(
  lines: readonly MobileDiffLine[],
  foldEnd: number
): string | null {
  const counts = (line: MobileDiffLine | undefined): line is MobileDiffLine =>
    line !== undefined && line.kind !== 'delete' && line.text.trim() !== ''
  let nextIndex = foldEnd
  while (nextIndex < lines.length && !counts(lines[nextIndex])) {
    nextIndex += 1
  }
  const next = lines[nextIndex]
  if (!counts(next)) {
    return null
  }
  const nextIndent = indentColumns(next.text)
  for (let index = foldEnd - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (counts(line) && indentColumns(line.text) < nextIndent) {
      return line.text.trim()
    }
  }
  return null
}
