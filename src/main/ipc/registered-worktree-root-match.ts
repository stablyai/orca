import { isDescendantOrEqual } from './filesystem/filesystem-path-containment'

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
