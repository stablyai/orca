import { buildLargeFileDiffLines } from './mobile-diff-bounded'
import {
  buildLcsDiffLines,
  finalizeMobileDiffLines,
  MAX_DIFF_CELLS,
  type MobileDiffLine,
  type MobileDiffLineKind
} from './mobile-diff-lcs'

export type { MobileDiffLine, MobileDiffLineKind }

export function buildMobileDiffLines(
  originalContent: string,
  modifiedContent: string,
  options?: { ignoreTrimWhitespace?: boolean }
): { lines: MobileDiffLine[]; truncated: boolean } {
  const originalLines = splitContentLines(originalContent)
  const modifiedLines = splitContentLines(modifiedContent)
  // Desktop's diff hides leading/trailing-whitespace-only edits unless whitespace is shown.
  const originalKeys = options?.ignoreTrimWhitespace
    ? originalLines.map((line) => line.trim())
    : originalLines
  const modifiedKeys = options?.ignoreTrimWhitespace
    ? modifiedLines.map((line) => line.trim())
    : modifiedLines
  // Why: the LCS table is quadratic. Past this budget, anchor on lines that
  // occur once on each side so separated edits keep the unchanged rows.
  // A region with no such anchor still uses prefix/suffix diffing.
  const lines =
    originalLines.length * modifiedLines.length <= MAX_DIFF_CELLS
      ? buildLcsDiffLines(originalLines, modifiedLines, originalKeys, modifiedKeys)
      : buildLargeFileDiffLines(originalLines, modifiedLines, originalKeys, modifiedKeys)

  return finalizeMobileDiffLines(lines)
}

function splitContentLines(content: string): string[] {
  if (content.length === 0) {
    return []
  }
  const lines = content.split(/\r?\n/)
  if (content.endsWith('\n')) {
    lines.pop()
  }
  return lines
}
