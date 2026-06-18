// Index math for DragReorderList. Kept worklet-safe (no captures, plain
// objects) because moveDragReorderKey runs on the UI thread during a drag.

export type DragReorderPositions = Record<string, number>

export function dragReorderPositionsFromKeys(keys: string[]): DragReorderPositions {
  'worklet'
  const positions: DragReorderPositions = {}
  for (let i = 0; i < keys.length; i++) {
    positions[keys[i]!] = i
  }
  return positions
}

export function orderedKeysFromDragReorderPositions(positions: DragReorderPositions): string[] {
  'worklet'
  const keys = Object.keys(positions)
  keys.sort((a, b) => positions[a]! - positions[b]!)
  return keys
}

export function clampDragReorderIndex(index: number, count: number): number {
  'worklet'
  if (count <= 0) {
    return 0
  }
  return Math.min(Math.max(index, 0), count - 1)
}

export function moveDragReorderKey(
  positions: DragReorderPositions,
  key: string,
  toIndex: number
): DragReorderPositions {
  'worklet'
  const fromIndex = positions[key]
  if (fromIndex === undefined || fromIndex === toIndex) {
    return positions
  }
  const next: DragReorderPositions = {}
  for (const currentKey of Object.keys(positions)) {
    const position = positions[currentKey]!
    if (currentKey === key) {
      next[currentKey] = toIndex
    } else if (fromIndex < toIndex && position > fromIndex && position <= toIndex) {
      next[currentKey] = position - 1
    } else if (toIndex < fromIndex && position >= toIndex && position < fromIndex) {
      next[currentKey] = position + 1
    } else {
      next[currentKey] = position
    }
  }
  return next
}
