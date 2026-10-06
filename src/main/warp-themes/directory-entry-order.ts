// Warp theme discovery walks user home and app-data trees, so callers filter to
// the entries they want *before* sorting: same resulting order (the comparator is
// a total order over a stable sort), without collating the hundreds of unrelated
// names a home directory holds.
export function sortDirectoryEntriesByName<T extends { name: string }>(entries: T[]): T[] {
  if (entries.length < 2) {
    return entries
  }
  const compare = new Intl.Collator(undefined, { sensitivity: 'base' }).compare
  return entries.sort((left, right) => compare(left.name, right.name))
}
