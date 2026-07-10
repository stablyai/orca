export type MobileDiffLineKind = 'context' | 'add' | 'delete'

export type MobileDiffLine = {
  kind: MobileDiffLineKind
  text: string
  oldLineNumber?: number
  newLineNumber?: number
}

const MAX_DIFF_CELLS = 200_000
const MAX_MOBILE_DIFF_LINES = 2_500
const MAX_BUILT_DIFF_LINES = MAX_MOBILE_DIFF_LINES + 1
const TRUNCATED_LINE: MobileDiffLine = {
  kind: 'context',
  text: '... diff truncated for mobile preview ...'
}

export function buildMobileDiffLines(
  originalContent: string,
  modifiedContent: string
): { lines: MobileDiffLine[]; truncated: boolean } {
  const originalLines = splitContentLines(originalContent)
  const modifiedLines = splitContentLines(modifiedContent)
  // Why: the LCS table is quadratic. Large generated files still need a
  // responsive mobile preview, so fall back to prefix/suffix diffing.
  const lines =
    originalLines.length * modifiedLines.length <= MAX_DIFF_CELLS
      ? buildLcsDiffLines(originalLines, modifiedLines)
      : buildPrefixSuffixDiffLines(originalLines, modifiedLines)

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

function buildLcsDiffLines(originalLines: string[], modifiedLines: string[]): MobileDiffLine[] {
  const rowWidth = modifiedLines.length + 1
  const dp = new Uint32Array((originalLines.length + 1) * rowWidth)
  for (let i = originalLines.length - 1; i >= 0; i -= 1) {
    for (let j = modifiedLines.length - 1; j >= 0; j -= 1) {
      dp[i * rowWidth + j] =
        originalLines[i] === modifiedLines[j]
          ? dp[(i + 1) * rowWidth + j + 1] + 1
          : Math.max(dp[(i + 1) * rowWidth + j], dp[i * rowWidth + j + 1])
    }
  }

  const lines: MobileDiffLine[] = []
  let originalIndex = 0
  let modifiedIndex = 0
  while (originalIndex < originalLines.length && modifiedIndex < modifiedLines.length) {
    if (originalLines[originalIndex] === modifiedLines[modifiedIndex]) {
      if (
        !appendDiffLine(lines, {
          kind: 'context',
          text: originalLines[originalIndex] ?? '',
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

function buildPrefixSuffixDiffLines(
  originalLines: string[],
  modifiedLines: string[]
): MobileDiffLine[] {
  let prefixLength = 0
  while (
    prefixLength < originalLines.length &&
    prefixLength < modifiedLines.length &&
    originalLines[prefixLength] === modifiedLines[prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength + prefixLength < originalLines.length &&
    suffixLength + prefixLength < modifiedLines.length &&
    originalLines[originalLines.length - suffixLength - 1] ===
      modifiedLines[modifiedLines.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }

  const lines: MobileDiffLine[] = []
  for (let i = 0; i < prefixLength; i += 1) {
    if (
      !appendDiffLine(lines, {
        kind: 'context',
        text: originalLines[i] ?? '',
        oldLineNumber: i + 1,
        newLineNumber: i + 1
      })
    ) {
      return lines
    }
  }
  for (let i = prefixLength; i < originalLines.length - suffixLength; i += 1) {
    if (
      !appendDiffLine(lines, {
        kind: 'delete',
        text: originalLines[i] ?? '',
        oldLineNumber: i + 1
      })
    ) {
      return lines
    }
  }
  for (let i = prefixLength; i < modifiedLines.length - suffixLength; i += 1) {
    if (
      !appendDiffLine(lines, {
        kind: 'add',
        text: modifiedLines[i] ?? '',
        newLineNumber: i + 1
      })
    ) {
      return lines
    }
  }
  for (let i = originalLines.length - suffixLength; i < originalLines.length; i += 1) {
    const modifiedIndex =
      modifiedLines.length - suffixLength + (i - (originalLines.length - suffixLength))
    if (
      !appendDiffLine(lines, {
        kind: 'context',
        text: originalLines[i] ?? '',
        oldLineNumber: i + 1,
        newLineNumber: modifiedIndex + 1
      })
    ) {
      return lines
    }
  }
  return lines
}

function appendDiffLine(lines: MobileDiffLine[], line: MobileDiffLine): boolean {
  // Why: the mobile preview only renders the first capped rows; keep one extra
  // row solely to preserve the existing "truncated" marker decision.
  lines.push(line)
  return lines.length < MAX_BUILT_DIFF_LINES
}

function finalizeMobileDiffLines(lines: MobileDiffLine[]): {
  lines: MobileDiffLine[]
  truncated: boolean
} {
  if (lines.length <= MAX_MOBILE_DIFF_LINES) {
    return { lines, truncated: false }
  }
  return { lines: [...lines.slice(0, MAX_MOBILE_DIFF_LINES), TRUNCATED_LINE], truncated: true }
}
