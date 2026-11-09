export type MobileDiffLineKind = 'context' | 'add' | 'delete'

export type MobileDiffLine = {
  kind: MobileDiffLineKind
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

export const MAX_DIFF_CELLS = 200_000
export const MAX_MOBILE_DIFF_LINES = 2_500
export const MAX_BUILT_DIFF_LINES = MAX_MOBILE_DIFF_LINES + 1
const TRUNCATED_LINE: MobileDiffLine = {
  kind: 'context',
  text: '... diff truncated for mobile preview ...'
}

export function appendDiffLine(lines: MobileDiffLine[], line: MobileDiffLine): boolean {
  // Why: the mobile preview only renders the first capped rows; keep one extra
  // row solely to preserve the existing "truncated" marker decision.
  lines.push(line)
  return lines.length < MAX_BUILT_DIFF_LINES
}

export function finalizeMobileDiffLines(lines: MobileDiffLine[]): {
  lines: MobileDiffLine[]
  truncated: boolean
} {
  if (lines.length <= MAX_MOBILE_DIFF_LINES) {
    return { lines, truncated: false }
  }
  return { lines: [...lines.slice(0, MAX_MOBILE_DIFF_LINES), TRUNCATED_LINE], truncated: true }
}

// Keys are the lines compared for equality; the lines themselves are what the diff shows.
export function buildLcsDiffLines(
  originalLines: string[],
  modifiedLines: string[],
  originalKeys: string[],
  modifiedKeys: string[]
): MobileDiffLine[] {
  const rowWidth = modifiedLines.length + 1
  const dp = new Uint32Array((originalLines.length + 1) * rowWidth)
  for (let i = originalLines.length - 1; i >= 0; i -= 1) {
    for (let j = modifiedLines.length - 1; j >= 0; j -= 1) {
      dp[i * rowWidth + j] =
        originalKeys[i] === modifiedKeys[j]
          ? dp[(i + 1) * rowWidth + j + 1] + 1
          : Math.max(dp[(i + 1) * rowWidth + j], dp[i * rowWidth + j + 1])
    }
  }

  const lines: MobileDiffLine[] = []
  let originalIndex = 0
  let modifiedIndex = 0
  while (originalIndex < originalLines.length && modifiedIndex < modifiedLines.length) {
    if (originalKeys[originalIndex] === modifiedKeys[modifiedIndex]) {
      if (
        !appendDiffLine(lines, {
          kind: 'context',
          text: modifiedLines[modifiedIndex] ?? '',
          oldLineNumber: originalIndex + 1,
          newLineNumber: modifiedIndex + 1
        })
      ) {
        return lines
      }
      originalIndex += 1
      modifiedIndex += 1
    } else if (
      dp[(originalIndex + 1) * rowWidth + modifiedIndex] >=
      dp[originalIndex * rowWidth + modifiedIndex + 1]
    ) {
      if (
        !appendDiffLine(lines, {
          kind: 'delete',
          text: originalLines[originalIndex] ?? '',
          oldLineNumber: originalIndex + 1
        })
      ) {
        return lines
      }
      originalIndex += 1
    } else {
      if (
        !appendDiffLine(lines, {
          kind: 'add',
          text: modifiedLines[modifiedIndex] ?? '',
          newLineNumber: modifiedIndex + 1
        })
      ) {
        return lines
      }
      modifiedIndex += 1
    }
  }

  while (originalIndex < originalLines.length) {
    if (
      !appendDiffLine(lines, {
        kind: 'delete',
        text: originalLines[originalIndex] ?? '',
        oldLineNumber: originalIndex + 1
      })
    ) {
      return lines
    }
    originalIndex += 1
  }
  while (modifiedIndex < modifiedLines.length) {
    if (
      !appendDiffLine(lines, {
        kind: 'add',
        text: modifiedLines[modifiedIndex] ?? '',
        newLineNumber: modifiedIndex + 1
      })
    ) {
      return lines
    }
    modifiedIndex += 1
  }

  return lines
}
