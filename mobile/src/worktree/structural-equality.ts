// Why: polls re-parse rows into fresh objects, so lists and rows compare by value to skip renders.
// Sets and Maps hold no enumerable entries, so they compare by content instead.
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
  if (a instanceof Set || b instanceof Set) {
    return (
      a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((v) => b.has(v))
    )
  }
  if (a instanceof Map || b instanceof Map) {
    return (
      a instanceof Map &&
      b instanceof Map &&
      a.size === b.size &&
      [...a].every(([key, value]) => b.has(key) && areStructurallyEqual(value, b.get(key)))
    )
  }
  const leftEntries = Object.entries(a)
  const rightEntries = new Map(Object.entries(b))
  return (
    leftEntries.length === rightEntries.size &&
    leftEntries.every(
      ([key, value]) => rightEntries.has(key) && areStructurallyEqual(value, rightEntries.get(key))
    )
  )
}
