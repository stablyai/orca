// Filter discovery entries before collation; stable total ordering stays the same without sorting unrelated home-directory names.
export function sortDirectoryEntriesByName<T extends { name: string }>(entries: T[]): T[] {
  if (entries.length < 2) {
    return entries
  }
  const compare = new Intl.Collator(undefined, { sensitivity: 'base' }).compare
  return entries.sort((left, right) => compare(left.name, right.name))
}
