import {
  isDescendantOrEqual,
  isDescendantOrEqualAsync
} from '../../../filesystem/local-file-io/filesystem-path-containment'

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

export async function findRegisteredWorktreeRootAsync(
  targetPath: string,
  registeredWorktreeRoots: Iterable<string>
): Promise<string | null> {
  let bestRoot: string | null = null
  for (const root of registeredWorktreeRoots) {
    if (
      (await isDescendantOrEqualAsync(targetPath, root)) &&
      (!bestRoot || root.length > bestRoot.length)
    ) {
      bestRoot = root
    }
  }
  return bestRoot
}
