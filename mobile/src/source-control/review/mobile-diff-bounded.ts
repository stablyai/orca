import { appendRawMiddle, findUniqueAnchors, type Anchor } from './mobile-diff-anchors'
import {
  appendDiffLine,
  buildLcsDiffLines,
  MAX_BUILT_DIFF_LINES,
  MAX_DIFF_CELLS,
  type MobileDiffLine
} from './mobile-diff-lcs'

const MAX_ANCHOR_DEPTH = 4

type LineSpan = {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
}

export function buildLargeFileDiffLines(
  originalLines: string[],
  modifiedLines: string[],
  originalKeys: string[],
  modifiedKeys: string[]
): MobileDiffLine[] {
  const lines: MobileDiffLine[] = []
  appendBoundedRegion(
    lines,
    originalLines,
    modifiedLines,
    originalKeys,
    modifiedKeys,
    { oldStart: 0, oldEnd: originalLines.length, newStart: 0, newEnd: modifiedLines.length },
    0
  )
  return lines
}

function appendBoundedRegion(
  lines: MobileDiffLine[],
  originalLines: string[],
  modifiedLines: string[],
  originalKeys: string[],
  modifiedKeys: string[],
  span: LineSpan,
  depth: number
): void {
  if (lines.length >= MAX_BUILT_DIFF_LINES) {
    return
  }
  const { oldStart, oldEnd, newStart, newEnd } = span
  let prefixLength = 0
  while (
    oldStart + prefixLength < oldEnd &&
    newStart + prefixLength < newEnd &&
    originalKeys[oldStart + prefixLength] === modifiedKeys[newStart + prefixLength]
  ) {
    prefixLength += 1
  }

  let suffixLength = 0
  while (
    suffixLength < oldEnd - oldStart - prefixLength &&
    suffixLength < newEnd - newStart - prefixLength &&
    originalKeys[oldEnd - suffixLength - 1] === modifiedKeys[newEnd - suffixLength - 1]
  ) {
    suffixLength += 1
  }

  if (!appendContextRun(lines, modifiedLines, oldStart, newStart, prefixLength)) {
    return
  }

  const oldMidStart = oldStart + prefixLength
  const oldMidEnd = oldEnd - suffixLength
  const newMidStart = newStart + prefixLength
  const newMidEnd = newEnd - suffixLength
  const oldMidLength = oldMidEnd - oldMidStart
  const newMidLength = newMidEnd - newMidStart
  if (oldMidLength > 0 || newMidLength > 0) {
    if (
      !appendMiddle(
        lines,
        originalLines,
        modifiedLines,
        originalKeys,
        modifiedKeys,
        oldMidStart,
        oldMidEnd,
        newMidStart,
        newMidEnd,
        oldMidLength,
        newMidLength,
        depth
      )
    ) {
      return
    }
  }

  appendContextRun(lines, modifiedLines, oldEnd - suffixLength, newEnd - suffixLength, suffixLength)
}

function appendMiddle(
  lines: MobileDiffLine[],
  originalLines: string[],
  modifiedLines: string[],
  originalKeys: string[],
  modifiedKeys: string[],
  oldMidStart: number,
  oldMidEnd: number,
  newMidStart: number,
  newMidEnd: number,
  oldMidLength: number,
  newMidLength: number,
  depth: number
): boolean {
  if (oldMidLength * newMidLength <= MAX_DIFF_CELLS) {
    return appendLcsSlice(
      lines,
      originalLines,
      modifiedLines,
      originalKeys,
      modifiedKeys,
      oldMidStart,
      oldMidEnd,
      newMidStart,
      newMidEnd
    )
  }
  const anchors =
    depth < MAX_ANCHOR_DEPTH
      ? findUniqueAnchors(
          originalKeys,
          modifiedKeys,
          oldMidStart,
          oldMidEnd,
          newMidStart,
          newMidEnd
        )
      : []
  if (anchors.length === 0) {
    return appendRawMiddle(
      lines,
      originalLines,
      modifiedLines,
      oldMidStart,
      oldMidEnd,
      newMidStart,
      newMidEnd
    )
  }
  return appendAnchoredMiddle(
    lines,
    originalLines,
    modifiedLines,
    originalKeys,
    modifiedKeys,
    anchors,
    oldMidStart,
    oldMidEnd,
    newMidStart,
    newMidEnd,
    depth
  )
}

function appendAnchoredMiddle(
  lines: MobileDiffLine[],
  originalLines: string[],
  modifiedLines: string[],
  originalKeys: string[],
  modifiedKeys: string[],
  anchors: readonly Anchor[],
  oldMidStart: number,
  oldMidEnd: number,
  newMidStart: number,
  newMidEnd: number,
  depth: number
): boolean {
  let previousOld = oldMidStart
  let previousNew = newMidStart
  for (const anchor of anchors) {
    appendBoundedRegion(
      lines,
      originalLines,
      modifiedLines,
      originalKeys,
      modifiedKeys,
      {
        oldStart: previousOld,
        oldEnd: anchor.oldIndex,
        newStart: previousNew,
        newEnd: anchor.newIndex
      },
      depth + 1
    )
    if (lines.length >= MAX_BUILT_DIFF_LINES) {
      return false
    }
    if (
      !appendDiffLine(lines, {
        kind: 'context',
        text: modifiedLines[anchor.newIndex] ?? '',
        oldLineNumber: anchor.oldIndex + 1,
        newLineNumber: anchor.newIndex + 1
      })
    ) {
      return false
    }
    previousOld = anchor.oldIndex + 1
    previousNew = anchor.newIndex + 1
  }
  appendBoundedRegion(
    lines,
    originalLines,
    modifiedLines,
    originalKeys,
    modifiedKeys,
    { oldStart: previousOld, oldEnd: oldMidEnd, newStart: previousNew, newEnd: newMidEnd },
    depth + 1
  )
  return lines.length < MAX_BUILT_DIFF_LINES
}

function appendContextRun(
  lines: MobileDiffLine[],
  modifiedLines: string[],
  oldStart: number,
  newStart: number,
  length: number
): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (
      !appendDiffLine(lines, {
        kind: 'context',
        text: modifiedLines[newStart + offset] ?? '',
        oldLineNumber: oldStart + offset + 1,
        newLineNumber: newStart + offset + 1
      })
    ) {
      return false
    }
  }
  return true
}

function appendLcsSlice(
  lines: MobileDiffLine[],
  originalLines: string[],
  modifiedLines: string[],
  originalKeys: string[],
  modifiedKeys: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number
): boolean {
  const built = buildLcsDiffLines(
    originalLines.slice(oldStart, oldEnd),
    modifiedLines.slice(newStart, newEnd),
    originalKeys.slice(oldStart, oldEnd),
    modifiedKeys.slice(newStart, newEnd)
  )
  for (const line of built) {
    const shifted: MobileDiffLine = { kind: line.kind, text: line.text }
    if (line.oldLineNumber !== undefined) {
      shifted.oldLineNumber = line.oldLineNumber + oldStart
    }
    if (line.newLineNumber !== undefined) {
      shifted.newLineNumber = line.newLineNumber + newStart
    }
    if (!appendDiffLine(lines, shifted)) {
      return false
    }
  }
  return true
}
