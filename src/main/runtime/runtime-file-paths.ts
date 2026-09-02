/** Return the final path component while accepting either platform separator. */
export function basenameFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
