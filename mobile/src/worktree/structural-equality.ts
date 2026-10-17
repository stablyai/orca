// Why: polls re-parse rows into fresh objects, so lists and rows compare by value to skip renders.
export function areStructurallyEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true
  }
  if (
    !a ||
    !b ||
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    return false
  }
  const leftEntries = Object.entries(a)
  const rightEntries = Object.entries(b)
  if (leftEntries.length !== rightEntries.length) {
    return false
  }
  let rightEntriesByKey: Map<string, unknown> | null = null
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index]
    if (key === rightEntry[0]) {
      return areStructurallyEqual(value, rightEntry[1])
    }
    // Preserve order-independent comparison without indexing catalogs whose keys already align.
    rightEntriesByKey ??= new Map(rightEntries)
    return rightEntriesByKey.has(key) && areStructurallyEqual(value, rightEntriesByKey.get(key))
  })
}
