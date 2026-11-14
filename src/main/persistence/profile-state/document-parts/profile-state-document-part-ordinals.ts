const ORDINAL_GAP = 1024

/**
 * Order-preserving ordinals that reuse as many existing values as possible, so inserting,
 * removing or moving one key rewrites only that key's row instead of renumbering the rest.
 * Keeps the longest run of keys whose previous ordinals are already increasing and spreads
 * the others into the gaps between them.
 */
export function assignProfileStatePartOrdinals(
  keys: readonly string[],
  previous: ReadonlyMap<string, number>
): number[] {
  const kept = keepLongestIncreasing(keys.map((key) => previous.get(key)))
  const ordinals: number[] = Array.from({ length: keys.length }, () => 0)
  let index = 0
  while (index < keys.length) {
    if (kept[index] !== undefined) {
      ordinals[index] = kept[index]!
      index++
      continue
    }
    let end = index
    while (end < keys.length && kept[end] === undefined) {
      end++
    }
    const count = end - index
    const low = index > 0 ? ordinals[index - 1]! : undefined
    const high = end < keys.length ? kept[end]! : undefined
    const start = low ?? (high !== undefined ? high - (count + 1) * ORDINAL_GAP : 0)
    const stop = high ?? start + (count + 1) * ORDINAL_GAP
    const step = Math.floor((stop - start) / (count + 1))
    if (step < 1) {
      return keys.map((_, position) => position * ORDINAL_GAP)
    }
    for (let offset = 0; offset < count; offset++) {
      ordinals[index + offset] = start + step * (offset + 1)
    }
    index = end
  }
  return ordinals
}

/** Longest strictly increasing subsequence; other positions become undefined. */
function keepLongestIncreasing(values: readonly (number | undefined)[]): (number | undefined)[] {
  const tails: number[] = []
  const tailIndex: number[] = []
  const parent: number[] = Array.from({ length: values.length }, () => -1)
  values.forEach((value, index) => {
    if (value === undefined) {
      return
    }
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (tails[middle]! < value) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    tails[low] = value
    tailIndex[low] = index
    parent[index] = low > 0 ? tailIndex[low - 1]! : -1
  })
  const kept: (number | undefined)[] = Array.from({ length: values.length }, () => undefined)
  let cursor = tailIndex.at(-1) ?? -1
  while (cursor !== -1) {
    kept[cursor] = values[cursor]
    cursor = parent[cursor]!
  }
  return kept
}
