type LineAnchor = { originalIndex: number; modifiedIndex: number }

export function findMobileDiffLineAnchors(
  originalKeys: readonly string[],
  modifiedKeys: readonly string[]
): LineAnchor[] {
  const originalPositions = uniqueLinePositions(originalKeys)
  const modifiedPositions = uniqueLinePositions(modifiedKeys)
  const candidates: LineAnchor[] = []
  for (const [key, originalIndex] of originalPositions) {
    if (key.trim().length === 0) {
      continue
    }
    const modifiedIndex = modifiedPositions.get(key)
    if (originalIndex >= 0 && modifiedIndex !== undefined && modifiedIndex >= 0) {
      candidates.push({ originalIndex, modifiedIndex })
    }
  }

  // Keep anchors ordered on both sides so diff sections cannot overlap.
  const tails: number[] = []
  const previous: number[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (candidates[tails[middle]].modifiedIndex < candidates[index].modifiedIndex) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    previous[index] = low === 0 ? -1 : tails[low - 1]
    tails[low] = index
  }

  const anchors: LineAnchor[] = []
  let index = tails.at(-1) ?? -1
  while (index >= 0) {
    anchors.push(candidates[index])
    index = previous[index]
  }
  return anchors.toReversed()
}

function uniqueLinePositions(keys: readonly string[]): Map<string, number> {
  const positions = new Map<string, number>()
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    positions.set(key, positions.has(key) ? -1 : index)
  }
  return positions
}
