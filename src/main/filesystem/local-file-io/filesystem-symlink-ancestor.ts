import { lstat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { isDescendantOrEqualExact } from './filesystem-path-containment'

/** The deepest component strictly below `rootPath` on the way to `targetPath` that is a symlink or junction, or null. */
export async function findDeepestSymlinkBelowRoot(
  rootPath: string,
  targetPath: string
): Promise<string | null> {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  if (root === target || !isDescendantOrEqualExact(target, root)) {
    return null
  }
  let current = root
  let deepest: string | null = null
  for (const segment of relative(root, target).split(sep)) {
    current = join(current, segment)
    // Why lstat, not realpath: realpath also folds letter case, which would flag ordinary folders.
    if ((await lstat(windowsFsPath(current))).isSymbolicLink()) {
      deepest = current
    }
  }
  return deepest
}
