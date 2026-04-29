const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:/

function isAbsoluteSparseDirectoryPath(entry: string): boolean {
  return entry.startsWith('/') || entry.startsWith('\\') || WINDOWS_DRIVE_PATH_PATTERN.test(entry)
}

export function normalizeSparseDirectories(directories: string[]): string[] {
  const seen = new Set<string>()
  return directories
    .map((entry) => entry.trim())
    .map((entry) => {
      // Why: absolute paths can look repo-relative after slash normalization.
      if (isAbsoluteSparseDirectoryPath(entry)) {
        throw new Error('Sparse checkout directories must be repo-relative paths.')
      }
      return entry.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    })
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
