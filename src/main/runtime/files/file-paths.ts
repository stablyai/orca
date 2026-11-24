export function basenameFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}
