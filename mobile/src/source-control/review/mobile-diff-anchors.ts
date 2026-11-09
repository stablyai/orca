import { appendDiffLine, type MobileDiffLine } from './mobile-diff-lcs'

export type Anchor = {
  oldIndex: number
  newIndex: number
}

export function appendRawMiddle(
  lines: MobileDiffLine[],
  originalLines: string[],
  modifiedLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number
): boolean {
  for (let index = oldStart; index < oldEnd; index += 1) {
    if (
      !appendDiffLine(lines, {
        kind: 'delete',
        text: originalLines[index] ?? '',
        oldLineNumber: index + 1
      })
    ) {
      return false
    }
  }
  for (let index = newStart; index < newEnd; index += 1) {
    if (
      !appendDiffLine(lines, {
        kind: 'add',
        text: modifiedLines[index] ?? '',
        newLineNumber: index + 1
      })
    ) {
      return false
    }
  }
  return true
}

export function findUniqueAnchors(
  originalKeys: string[],
  modifiedKeys: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number
): Anchor[] {
  const oldCounts = new Map<string, number>()
  const newCounts = new Map<string, number>()
  for (let index = oldStart; index < oldEnd; index += 1) {
    const key = originalKeys[index] ?? ''
    oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1)
  }
  for (let index = newStart; index < newEnd; index += 1) {
    const key = modifiedKeys[index] ?? ''
    newCounts.set(key, (newCounts.get(key) ?? 0) + 1)
  }
  const newIndexByKey = new Map<string, number>()
  for (let index = newStart; index < newEnd; index += 1) {
    const key = modifiedKeys[index] ?? ''
    if (newCounts.get(key) === 1) {
      newIndexByKey.set(key, index)
    }
  }
  const pairs: Anchor[] = []
  for (let index = oldStart; index < oldEnd; index += 1) {
    const key = originalKeys[index] ?? ''
    const newIndex = newIndexByKey.get(key)
    if (oldCounts.get(key) === 1 && newIndex !== undefined) {
      pairs.push({ oldIndex: index, newIndex })
    }
  }
  return longestIncreasingAnchors(pairs)
}

function longestIncreasingAnchors(pairs: readonly Anchor[]): Anchor[] {
  const predecessor = Array.from({ length: pairs.length }, () => -1)
  const pileTops: number[] = []
  for (let index = 0; index < pairs.length; index += 1) {
    const value = pairs[index]?.newIndex ?? 0
    let low = 0
    let high = pileTops.length
    while (low < high) {
      const mid = (low + high) >> 1
      const top = pileTops[mid] ?? 0
      if ((pairs[top]?.newIndex ?? 0) < value) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    if (low > 0) {
      predecessor[index] = pileTops[low - 1] ?? -1
    }
    if (low === pileTops.length) {
      pileTops.push(index)
    } else {
      pileTops[low] = index
    }
  }
  const chosen: Anchor[] = []
  let cursor = pileTops.length === 0 ? -1 : (pileTops[pileTops.length - 1] ?? -1)
  while (cursor >= 0) {
    const pair = pairs[cursor]
    if (pair) {
      chosen.push(pair)
    }
    cursor = predecessor[cursor] ?? -1
  }
  chosen.reverse()
  return chosen
}
