import { dirname, extname, relative } from 'node:path'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'

/** Whether a walked path is a session file this source owns. Split from the source table
 *  so adding an agent does not push that module past its line budget. */
export function isDiscoverableSessionFile(
  source: AiVaultAgentSource,
  rootDir: string,
  filePath: string
): boolean {
  if (!source.extensions.includes(extname(filePath).toLowerCase())) {
    return false
  }
  if (source.filePredicate && !source.filePredicate(filePath)) {
    return false
  }
  const { directoryPredicate } = source
  if (!directoryPredicate) {
    return true
  }
  // Indexed like walkSessionFiles: depth 0 is a child of rootDir.
  return pathSegments(relative(rootDir, dirname(filePath)))
    .filter(Boolean)
    .every((name, depth) => directoryPredicate(name, depth))
}

export function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/)
}
