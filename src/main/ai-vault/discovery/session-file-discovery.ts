import { dirname, extname, isAbsolute, relative } from 'node:path'
import type { AiVaultAgentSource } from '../session-scanner-types'

export function isDiscoverableSessionFile(
  source: Pick<AiVaultAgentSource, 'extensions' | 'filePredicate' | 'directoryPredicate'>,
  rootDir: string,
  filePath: string
): boolean {
  if (
    !source.extensions.includes('*') &&
    !source.extensions.includes(extname(filePath).toLowerCase())
  ) {
    return false
  }
  if (source.filePredicate && !source.filePredicate(filePath)) {
    return false
  }
  const { directoryPredicate } = source
  if (!directoryPredicate) {
    return true
  }
  // Match walkSessionFiles: root children have depth 0.
  return pathSegments(relative(rootDir, dirname(filePath)))
    .filter(Boolean)
    .every((name, depth) => directoryPredicate(name, depth))
}

export function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/)
}

export function isInsideSessionRoot(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}
