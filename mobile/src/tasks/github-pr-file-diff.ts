export type GitHubPrFileDiffLine = {
  key: string
  kind: 'context' | 'added' | 'removed'
  oldLineNumber?: number
  newLineNumber?: number
  text: string
}

type DiffOperation =
  | { kind: 'context'; oldLine: string; newLine: string }
  | { kind: 'removed'; oldLine: string }
  | { kind: 'added'; newLine: string }

const EXACT_DIFF_CELL_LIMIT = 160_000

function splitContentLines(value: string): string[] {
  if (!value) {
    return []
  }
  const lines = value.split(/\r?\n/)
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

function exactLineDiff(original: string[], modified: string[]): DiffOperation[] {
  const rowWidth = modified.length + 1
  const table = new Uint16Array((original.length + 1) * rowWidth)

  for (let oldIndex = original.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = modified.length - 1; newIndex >= 0; newIndex -= 1) {
      const cell = oldIndex * rowWidth + newIndex
      if (original[oldIndex] === modified[newIndex]) {
        table[cell] = table[(oldIndex + 1) * rowWidth + newIndex + 1] + 1
      } else {
        table[cell] = Math.max(
          table[(oldIndex + 1) * rowWidth + newIndex],
          table[oldIndex * rowWidth + newIndex + 1]
        )
      }
    }
  }

  const operations: DiffOperation[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < original.length && newIndex < modified.length) {
    const oldLine = original[oldIndex]
    const newLine = modified[newIndex]
    if (oldLine === newLine) {
      operations.push({ kind: 'context', oldLine, newLine })
      oldIndex += 1
      newIndex += 1
      continue
    }
    const removeScore = table[(oldIndex + 1) * rowWidth + newIndex]
    const addScore = table[oldIndex * rowWidth + newIndex + 1]
    if (removeScore >= addScore) {
      operations.push({ kind: 'removed', oldLine })
      oldIndex += 1
    } else {
      operations.push({ kind: 'added', newLine })
      newIndex += 1
    }
  }
  while (oldIndex < original.length) {
    operations.push({ kind: 'removed', oldLine: original[oldIndex] })
    oldIndex += 1
  }
  while (newIndex < modified.length) {
    operations.push({ kind: 'added', newLine: modified[newIndex] })
    newIndex += 1
  }
  return operations
}

function buildMiddleDiff(original: string[], modified: string[]): DiffOperation[] {
  if (original.length === 0) {
    return modified.map((newLine) => ({ kind: 'added', newLine }))
  }
  if (modified.length === 0) {
    return original.map((oldLine) => ({ kind: 'removed', oldLine }))
  }
  if (original.length * modified.length <= EXACT_DIFF_CELL_LIMIT) {
    return exactLineDiff(original, modified)
  }
  // Why: very large files must still show all content without an O(n*m) mobile stall.
  return [
    ...original.map((oldLine) => ({ kind: 'removed' as const, oldLine })),
    ...modified.map((newLine) => ({ kind: 'added' as const, newLine }))
  ]
}

export function buildGitHubPrFileDiffLines(
  originalContent: string,
  modifiedContent: string
): GitHubPrFileDiffLine[] {
  const originalLines = splitContentLines(originalContent)
  const modifiedLines = splitContentLines(modifiedContent)
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
    suffixLength < originalLines.length - prefixLength &&
    suffixLength < modifiedLines.length - prefixLength &&
    originalLines[originalLines.length - suffixLength - 1] ===
      modifiedLines[modifiedLines.length - suffixLength - 1]
  ) {
    suffixLength += 1
  }

  const prefix = originalLines.slice(0, prefixLength)
  const originalMiddle = originalLines.slice(
    prefixLength,
    suffixLength === 0 ? originalLines.length : originalLines.length - suffixLength
  )
  const modifiedMiddle = modifiedLines.slice(
    prefixLength,
    suffixLength === 0 ? modifiedLines.length : modifiedLines.length - suffixLength
  )
  const suffix = originalLines.slice(originalLines.length - suffixLength)
  const operations: DiffOperation[] = [
    ...prefix.map((line) => ({ kind: 'context' as const, oldLine: line, newLine: line })),
    ...buildMiddleDiff(originalMiddle, modifiedMiddle),
    ...suffix.map((line) => ({ kind: 'context' as const, oldLine: line, newLine: line }))
  ]

  const result: GitHubPrFileDiffLine[] = []
  let oldLineNumber = 1
  let newLineNumber = 1
  operations.forEach((operation, index) => {
    if (operation.kind === 'context') {
      result.push({
        key: `${index}:context:${oldLineNumber}:${newLineNumber}`,
        kind: 'context',
        oldLineNumber,
        newLineNumber,
        text: operation.newLine
      })
      oldLineNumber += 1
      newLineNumber += 1
      return
    }
    if (operation.kind === 'removed') {
      result.push({
        key: `${index}:removed:${oldLineNumber}`,
        kind: 'removed',
        oldLineNumber,
        text: operation.oldLine
      })
      oldLineNumber += 1
      return
    }
    result.push({
      key: `${index}:added:${newLineNumber}`,
      kind: 'added',
      newLineNumber,
      text: operation.newLine
    })
    newLineNumber += 1
  })
  return result
}
