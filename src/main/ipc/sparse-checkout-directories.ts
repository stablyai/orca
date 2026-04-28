export function normalizeSparseDirectories(directories: string[]): string[] {
  const seen = new Set<string>()
  return directories
    .map((entry) =>
      entry
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
    )
    .filter((entry) => entry.length > 0 && entry !== '.')
    .filter((entry) => {
      if (entry.split('/').includes('..')) {
        throw new Error('Sparse checkout directories must be repo-relative paths.')
      }
      if (seen.has(entry)) {
        return false
      }
      seen.add(entry)
      return true
    })
}
