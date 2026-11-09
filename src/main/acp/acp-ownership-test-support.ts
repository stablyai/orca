export function retainedCollectionEntries(value: unknown, seen = new Set<object>()): number {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return 0
  }
  seen.add(value)
  if (value instanceof Map) {
    return (
      value.size +
      [...value.values()].reduce((sum, item) => sum + retainedCollectionEntries(item, seen), 0)
    )
  }
  if (value instanceof Set) {
    return value.size
  }
  return Object.values(value).reduce<number>(
    (sum, item) => sum + retainedCollectionEntries(item, seen),
    0
  )
}
