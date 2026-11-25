import { buildMobileDiffChanges, type MobileDiffChange } from './mobile-diff-line-changes'

export type MobileDiffLineKind = 'context' | 'add' | 'delete'

export type MobileDiffLine = {
  kind: MobileDiffLineKind
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

const MAX_DIFF_CELLS = 200_000
const MAX_MOBILE_DIFF_LINES = 20_000
// The file tab has no truncation footer, so the marker row is its only notice.
const TRUNCATED_LINE: MobileDiffLine = {
  kind: 'context',
  text: '... diff truncated for mobile preview ...'
}

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
  const changes =
    (originalKeys.length + 1) * (modifiedKeys.length + 1) <= MAX_DIFF_CELLS
      ? buildLcsDiffChanges(originalKeys, modifiedKeys)
      : buildMobileDiffChanges(originalKeys, modifiedKeys)
  const lines = buildChangeDiffLines(changes, originalLines, modifiedLines)

  const truncated = lines.length > MAX_MOBILE_DIFF_LINES
  if (truncated) {
    lines[MAX_MOBILE_DIFF_LINES] = TRUNCATED_LINE
  }
  return { lines, truncated }
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

// Keys are the lines compared for equality; the lines themselves are what the diff shows.
function* buildLcsDiffChanges(
  originalKeys: string[],
  modifiedKeys: string[]
): Generator<MobileDiffChange> {
  const rowWidth = modifiedKeys.length + 1
  const dp = new Uint32Array((originalKeys.length + 1) * rowWidth)
  for (let i = originalKeys.length - 1; i >= 0; i -= 1) {
    for (let j = modifiedKeys.length - 1; j >= 0; j -= 1) {
      dp[i * rowWidth + j] =
        originalKeys[i] === modifiedKeys[j]
          ? dp[(i + 1) * rowWidth + j + 1] + 1
          : Math.max(dp[(i + 1) * rowWidth + j], dp[i * rowWidth + j + 1])
    }
  }

  let originalIndex = 0
  let modifiedIndex = 0
  while (originalIndex < originalKeys.length && modifiedIndex < modifiedKeys.length) {
    if (originalKeys[originalIndex] === modifiedKeys[modifiedIndex]) {
      yield { count: 1, added: false, removed: false }
      originalIndex += 1
      modifiedIndex += 1
    } else if (
      dp[(originalIndex + 1) * rowWidth + modifiedIndex] >=
      dp[originalIndex * rowWidth + modifiedIndex + 1]
    ) {
      yield { count: 1, added: false, removed: true }
      originalIndex += 1
    } else {
      yield { count: 1, added: true, removed: false }
      modifiedIndex += 1
    }
  }

  if (originalIndex < originalKeys.length) {
    yield { count: originalKeys.length - originalIndex, added: false, removed: true }
  }
  if (modifiedIndex < modifiedKeys.length) {
    yield { count: modifiedKeys.length - modifiedIndex, added: true, removed: false }
  }
}

function buildChangeDiffLines(
  changes: Iterable<MobileDiffChange>,
  originalLines: string[],
  modifiedLines: string[]
): MobileDiffLine[] {
  const lines: MobileDiffLine[] = []
  let originalIndex = 0
  let modifiedIndex = 0
  for (const change of changes) {
    for (let i = 0; i < change.count; i += 1) {
      let line: MobileDiffLine
      if (change.removed) {
        line = {
          kind: 'delete',
          text: originalLines[originalIndex] ?? '',
          oldLineNumber: originalIndex + 1
        }
        originalIndex += 1
      } else if (change.added) {
        line = {
          kind: 'add',
          text: modifiedLines[modifiedIndex] ?? '',
          newLineNumber: modifiedIndex + 1
        }
        modifiedIndex += 1
      } else {
        line = {
          kind: 'context',
          text: modifiedLines[modifiedIndex] ?? '',
          oldLineNumber: originalIndex + 1,
          newLineNumber: modifiedIndex + 1
        }
        originalIndex += 1
        modifiedIndex += 1
      }
      lines.push(line)
      // One extra row distinguishes an exact fit from a truncated preview.
      if (lines.length > MAX_MOBILE_DIFF_LINES) {
        return lines
      }
    }
  }
  return lines
}
