import {
  collectGitHubPrFileLineRange,
  createGitHubPrFileLineSource,
  findGitHubPrFileCommonLineEdges,
  visitGitHubPrFileLineRange,
  type GitHubPrFileLineSource
} from './github-pr-file-line-scan'

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
  const original = createGitHubPrFileLineSource(originalContent)
  const modified = createGitHubPrFileLineSource(modifiedContent)
  const { prefixLineCount, suffixLineCount } = findGitHubPrFileCommonLineEdges(original, modified)
  const originalMiddleLineCount = original.lineCount - prefixLineCount - suffixLineCount
  const modifiedMiddleLineCount = modified.lineCount - prefixLineCount - suffixLineCount
  const result: GitHubPrFileDiffLine[] = []
  let oldLineNumber = 1
  let newLineNumber = 1
  let operationIndex = 0
  let totalLineCount = 0
  const normalizedMaxLines = Number.isNaN(maxLines) ? 0 : Math.max(0, Math.floor(maxLines))
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

  function skipOperations(kind: DiffOperation['kind'], count: number): void {
    operationIndex += count
    totalLineCount += count
    if (kind === 'context') {
      oldLineNumber += count
      newLineNumber += count
    } else if (kind === 'removed') {
      oldLineNumber += count
    } else {
      newLineNumber += count
    }
  }

  function appendLineRange(
    kind: DiffOperation['kind'],
    source: GitHubPrFileLineSource,
    startLine: number,
    lineCount: number
  ): void {
    const retainedLineCount = Math.min(lineCount, Math.max(0, normalizedMaxLines - result.length))
    visitGitHubPrFileLineRange(source, startLine, retainedLineCount, (line) => {
      if (kind === 'context') {
        appendOperation({ kind, oldLine: line, newLine: line })
      } else if (kind === 'removed') {
        appendOperation({ kind, oldLine: line })
      } else {
        appendOperation({ kind, newLine: line })
      }
    })
    skipOperations(kind, lineCount - retainedLineCount)
  }

  appendLineRange('context', original, 0, prefixLineCount)
  if (originalMiddleLineCount === 0) {
    appendLineRange('added', modified, prefixLineCount, modifiedMiddleLineCount)
  } else if (modifiedMiddleLineCount === 0) {
    appendLineRange('removed', original, prefixLineCount, originalMiddleLineCount)
  } else if (originalMiddleLineCount * modifiedMiddleLineCount <= EXACT_DIFF_CELL_LIMIT) {
    appendExactLineDiff(
      collectGitHubPrFileLineRange(original, prefixLineCount, originalMiddleLineCount),
      collectGitHubPrFileLineRange(modified, prefixLineCount, modifiedMiddleLineCount),
      appendOperation
    )
  } else {
    // Why: large generated files need exact counts without retaining discarded preview rows.
    appendLineRange('removed', original, prefixLineCount, originalMiddleLineCount)
    appendLineRange('added', modified, prefixLineCount, modifiedMiddleLineCount)
  }
  appendLineRange('context', original, original.lineCount - suffixLineCount, suffixLineCount)

  return { lines: result, totalLineCount }
}
