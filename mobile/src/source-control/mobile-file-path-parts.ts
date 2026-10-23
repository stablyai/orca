/** A repo-relative path as a list row shows it: the file name bright, its folder muted beneath. */
export function splitMobileFilePath(path: string): { name: string; directory: string } {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  if (slash === -1) {
    return { name: trimmed, directory: '' }
  }
  return { name: trimmed.slice(slash + 1), directory: trimmed.slice(0, slash) }
}
