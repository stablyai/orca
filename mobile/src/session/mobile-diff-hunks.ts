import type { MobileDiffLine } from './mobile-diff-lines'

export type MobileDiffHunk = {
  index: number
  startIndex: number
  endIndex: number
  addedLines: number
  deletedLines: number
  firstLineNumber: number | null
}

function isChangedLine(line: MobileDiffLine): boolean {
  return line.kind === 'add' || line.kind === 'delete'
}

function lineNumberForHunk(line: MobileDiffLine): number | null {
  return line.newLineNumber ?? line.oldLineNumber ?? null
}

export function buildMobileDiffHunks(lines: readonly MobileDiffLine[]): MobileDiffHunk[] {
  const hunks: MobileDiffHunk[] = []
  let startIndex: number | null = null
  let addedLines = 0
  let deletedLines = 0
  let firstLineNumber: number | null = null

  const closeHunk = (endIndex: number) => {
    if (startIndex === null) {
      return
    }
    hunks.push({
      index: hunks.length,
      startIndex,
      endIndex,
      addedLines,
      deletedLines,
      firstLineNumber
    })
    startIndex = null
    addedLines = 0
    deletedLines = 0
    firstLineNumber = null
  }

  lines.forEach((line, index) => {
    if (!isChangedLine(line)) {
      closeHunk(index - 1)
      return
    }
    if (startIndex === null) {
      startIndex = index
      firstLineNumber = lineNumberForHunk(line)
    }
    if (line.kind === 'add') {
      addedLines += 1
    } else {
      deletedLines += 1
    }
  })
  closeHunk(lines.length - 1)
  return hunks
}

export function findNextMobileDiffHunkIndex(
  hunks: readonly MobileDiffHunk[],
  currentLineIndex: number
): number | null {
  if (hunks.length === 0) {
    return null
  }
  return hunks.find((hunk) => hunk.startIndex > currentLineIndex)?.index ?? hunks[0]?.index ?? null
}

export function findPreviousMobileDiffHunkIndex(
  hunks: readonly MobileDiffHunk[],
  currentLineIndex: number
): number | null {
  if (hunks.length === 0) {
    return null
  }
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index]
    if (hunk && hunk.startIndex < currentLineIndex) {
      return hunk.index
    }
  }
  return hunks[hunks.length - 1]?.index ?? null
}
