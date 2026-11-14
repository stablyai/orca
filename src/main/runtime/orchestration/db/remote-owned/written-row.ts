/** A row read back inside the transaction that just wrote it; its absence is a broken invariant, not a state. */
export function writtenRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new Error(`${what} was not found right after it was written.`)
  }
  return row
}
