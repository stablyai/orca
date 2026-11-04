/** Rows whose destination key repeats are all dropped and counted: neither copy can win. */
export function uniqueDestinationRows<T>(
  rows: T[],
  key: (row: T) => string,
  onDuplicate: () => void
): T[] {
  const unique = new Map<string, T>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    const rowKey = key(row)
    if (duplicates.has(rowKey)) {
      onDuplicate()
    } else if (unique.has(rowKey)) {
      unique.delete(rowKey)
      duplicates.add(rowKey)
      onDuplicate()
    } else {
      unique.set(rowKey, row)
    }
  }
  return [...unique.values()]
}
