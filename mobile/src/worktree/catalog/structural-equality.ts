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
  const rightEntries = new Map(Object.entries(b))
  return (
    leftEntries.length === rightEntries.size &&
    leftEntries.every(
      ([key, value]) => rightEntries.has(key) && areStructurallyEqual(value, rightEntries.get(key))
    )
  )
}
