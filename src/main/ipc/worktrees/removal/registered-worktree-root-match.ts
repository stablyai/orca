import { isDescendantOrEqualAsync } from '../../../filesystem/local-file-io/filesystem-path-containment'

export async function findRegisteredWorktreeRootAsync(
  targetPath: string,
  registeredWorktreeRoots: Iterable<string>
): Promise<string | null> {
  let bestRoot: string | null = null
  for (const root of registeredWorktreeRoots) {
    const contained = isDescendantOrEqualAsync(targetPath, root)
    if (
      (typeof contained === 'boolean' ? contained : await contained) &&
      (!bestRoot || root.length > bestRoot.length)
    ) {
      bestRoot = root
    }
  }
  return bestRoot
}
