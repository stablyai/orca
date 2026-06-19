export type GitHubPrFileDiffLine = {
  key: string
  kind: 'context' | 'added' | 'removed'
  oldLineNumber?: number
  newLineNumber?: number
  text: string
}

export type GitHubPrFileDiffPreview = {
  lines: GitHubPrFileDiffLine[]
  totalLineCount: number
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

function appendExactLineDiff(
  original: string[],
  modified: string[],
  appendOperation: (operation: DiffOperation) => void
): void {
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

  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < original.length && newIndex < modified.length) {
    const oldLine = original[oldIndex]
    const newLine = modified[newIndex]
    if (oldLine === newLine) {
      appendOperation({ kind: 'context', oldLine, newLine })
      oldIndex += 1
      newIndex += 1
      continue
    }
    const removeScore = table[(oldIndex + 1) * rowWidth + newIndex]
    const addScore = table[oldIndex * rowWidth + newIndex + 1]
    if (removeScore >= addScore) {
      appendOperation({ kind: 'removed', oldLine })
      oldIndex += 1
    } else {
      appendOperation({ kind: 'added', newLine })
      newIndex += 1
    }
  }
  while (oldIndex < original.length) {
    appendOperation({ kind: 'removed', oldLine: original[oldIndex] })
    oldIndex += 1
  }
  while (newIndex < modified.length) {
    appendOperation({ kind: 'added', newLine: modified[newIndex] })
    newIndex += 1
  }
}

function appendMiddleDiff(
  original: string[],
  modified: string[],
  appendOperation: (operation: DiffOperation) => void
): void {
  if (original.length === 0) {
    for (const newLine of modified) {
      appendOperation({ kind: 'added', newLine })
    }
    return
  }
  if (modified.length === 0) {
    for (const oldLine of original) {
      appendOperation({ kind: 'removed', oldLine })
    }
    return
  }
  if (original.length * modified.length <= EXACT_DIFF_CELL_LIMIT) {
    appendExactLineDiff(original, modified, appendOperation)
    return
  }
  // Why: the Tasks diff UI renders a capped preview. Stream fallback rows so a
  // generated PR file does not allocate thousands of discarded row objects.
  for (const oldLine of original) {
    appendOperation({ kind: 'removed', oldLine })
  }
  for (const newLine of modified) {
    appendOperation({ kind: 'added', newLine })
  }
}

export function buildGitHubPrFileDiffLines(
  originalContent: string,
  modifiedContent: string
): GitHubPrFileDiffLine[] {
  return buildGitHubPrFileDiffPreview(originalContent, modifiedContent).lines
}

export function buildGitHubPrFileDiffPreview(
  originalContent: string,
  modifiedContent: string,
  maxLines = Number.POSITIVE_INFINITY
): GitHubPrFileDiffPreview {
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

  const originalMiddle = originalLines.slice(
    prefixLength,
    suffixLength === 0 ? originalLines.length : originalLines.length - suffixLength
  )
  const modifiedMiddle = modifiedLines.slice(
    prefixLength,
    suffixLength === 0 ? modifiedLines.length : modifiedLines.length - suffixLength
  )

  const result: GitHubPrFileDiffLine[] = []
  let oldLineNumber = 1
  let newLineNumber = 1
  let operationIndex = 0
  let totalLineCount = 0
  const normalizedMaxLines = Math.max(0, Math.floor(maxLines))
  function appendOperation(operation: DiffOperation): void {
    const index = operationIndex
    operationIndex += 1
    totalLineCount += 1
    if (operation.kind === 'context') {
      if (result.length < normalizedMaxLines) {
        result.push({
          key: `${index}:context:${oldLineNumber}:${newLineNumber}`,
          kind: 'context',
          oldLineNumber,
          newLineNumber,
          text: operation.newLine
        })
      }
      oldLineNumber += 1
      newLineNumber += 1
      return
    }
    if (operation.kind === 'removed') {
      if (result.length < normalizedMaxLines) {
        result.push({
          key: `${index}:removed:${oldLineNumber}`,
          kind: 'removed',
          oldLineNumber,
          text: operation.oldLine
        })
      }
      oldLineNumber += 1
      return
    }
    if (result.length < normalizedMaxLines) {
      result.push({
        key: `${index}:added:${newLineNumber}`,
        kind: 'added',
        newLineNumber,
        text: operation.newLine
      })
    }
    newLineNumber += 1
  }

  for (let i = 0; i < prefixLength; i += 1) {
    const line = originalLines[i] ?? ''
    appendOperation({ kind: 'context', oldLine: line, newLine: line })
  }
  appendMiddleDiff(originalMiddle, modifiedMiddle, appendOperation)
  for (let i = originalLines.length - suffixLength; i < originalLines.length; i += 1) {
    const line = originalLines[i] ?? ''
    appendOperation({ kind: 'context', oldLine: line, newLine: line })
  }

  return { lines: result, totalLineCount }
}
