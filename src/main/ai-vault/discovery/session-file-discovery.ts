import { dirname, extname, relative } from 'node:path'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'

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
  // Match walkSessionFiles: root children have depth 0.
  return pathSegments(relative(rootDir, dirname(filePath)))
    .filter(Boolean)
    .every((name, depth) => directoryPredicate(name, depth))
}

export function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/)
}
