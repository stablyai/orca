import { resolve } from 'node:path'
import { isDescendantOrEqual } from '../../../filesystem/local-file-io/filesystem-path-containment'

export function resolveRegisteredRootPath(pathValue: string): string {
  if (
    process.platform !== 'win32' &&
    pathValue.length > 1 &&
    pathValue.charCodeAt(0) === 47 &&
    pathValue.charCodeAt(pathValue.length - 1) !== 47 &&
    !pathValue.includes('//') &&
    !pathValue.includes('/.')
  ) {
    return pathValue
  }
  return resolve(pathValue)
}

export function hasDirtyRegisteredOwner(owners: Iterable<{ dirty: boolean }>): boolean {
  for (const owner of owners) {
    if (owner.dirty) {
      return true
    }
  }
  return false
}

export function findRegisteredWorktreeRoot(
  targetPath: string,
  registeredWorktreeRoots: Iterable<string>
): string | null {
  let bestRoot: string | null = null
  for (const root of registeredWorktreeRoots) {
    if (isDescendantOrEqual(targetPath, root) && (!bestRoot || root.length > bestRoot.length)) {
      bestRoot = root
    }
  }
  return bestRoot
}
