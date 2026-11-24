// Keep index math capture-free/plain-object worklet-safe; moveDragReorderKey runs on UI thread.

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

export type DragReorderMove = { movedId: string } & ({ beforeId: string } | { afterId: string })

export function dragReorderMove(keys: string[], movedId: string): DragReorderMove | null {
  const at = keys.indexOf(movedId)
  if (at === -1) {
    return null
  }
  const beforeId = keys[at + 1]
  const afterId = keys[at - 1]
  return beforeId ? { movedId, beforeId } : afterId ? { movedId, afterId } : null
}

export type DragReorderLayout = { keys: string[]; tops: Record<string, number> }

export function dragReorderLayout(
  positions: DragReorderPositions,
  sizes: Record<string, number>
): DragReorderLayout {
  'worklet'
  const keys: string[] = []
  for (const key of Object.keys(positions)) {
    keys[positions[key]!] = key
  }
  const tops: Record<string, number> = {}
  let top = 0
  for (const key of keys) {
    tops[key] = top
    top += sizes[key] ?? 0
  }
  return { keys, tops }
}

export function dragReorderTarget(
  positions: DragReorderPositions,
  sizes: Record<string, number>,
  layout: DragReorderLayout,
  key: string,
  top: number
): number {
  'worklet'
  const from = positions[key] ?? 0
  let target = from
  for (const other of layout.keys) {
    const height = sizes[other] ?? 0
    const index = positions[other] ?? 0
    const midpoint = (layout.tops[other] ?? 0) + height / 2
    if (index < from && top < midpoint) {
      target = Math.min(target, index)
    }
    if (index > from && top + (sizes[key] ?? 0) > midpoint) {
      target = index
    }
  }
  return target
}
