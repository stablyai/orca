const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/

export function getPRReviewCommentLineNumbersFromPatch(patch: string | undefined): number[] {
  if (!patch) {
    return []
  }

  const lineNumbers: number[] = []
  let nextModifiedLine: number | null = null

  for (const line of patch.split('\n')) {
    const hunk = HUNK_HEADER_RE.exec(line)
    if (hunk) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      nextModifiedLine = Number.isInteger(start) && count > 0 ? start : null
      continue
    }

    if (nextModifiedLine === null || line.startsWith('\\')) {
      continue
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      lineNumbers.push(nextModifiedLine)
      nextModifiedLine++
      continue
    }

    if (line.startsWith(' ')) {
      lineNumbers.push(nextModifiedLine)
      nextModifiedLine++
      continue
    }

    if (!line.startsWith('-')) {
      nextModifiedLine++
    }
  }

  return lineNumbers
}
