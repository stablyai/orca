import { lstat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { windowsFsPath } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import { isDescendantOrEqualExact } from './access/filesystem-path-containment'

/** True when a component strictly below `rootPath` on the way to `targetPath` is a symlink or junction. */
export async function hasSymlinkBelowRoot(rootPath: string, targetPath: string): Promise<boolean> {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  if (root === target || !isDescendantOrEqualExact(target, root)) {
    return false
  }
  let current = root
  for (const segment of relative(root, target).split(sep)) {
    current = join(current, segment)
    // Why lstat, not realpath: realpath also folds letter case, which would flag ordinary folders.
    if ((await lstat(windowsFsPath(current))).isSymbolicLink()) {
      return true
    }
  }
  return false
}
