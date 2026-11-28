/** The first existing data row for each key; a repeated key keeps the original upsert target. */
export function indexSheetRowsByKey(
  rows: readonly string[][],
  keyColumn: number
): Map<string, number> {
  const index = new Map<string, number>()
  for (let row = 1; row < rows.length; row++) {
    const key = rows[row]?.[keyColumn]
    if (key && !index.has(key)) {
      index.set(key, row)
    }
  }
  return index
}
