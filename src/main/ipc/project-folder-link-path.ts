import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { lstat } from 'node:fs/promises'
import { PATH_ACCESS_DENIED_MESSAGE } from './filesystem/filesystem-auth'
import { realpathAcrossWslDriveMount, windowsFsPath } from '../wsl/wsl-unc-drive-fs-path'

/** List only folders reached through a symlink whose own folder is inside a project. */
export async function resolveProjectFolderLinkPath(
  targetPath: string,
  authorizeProjectPath: (path: string) => Promise<string>
): Promise<string> {
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const resolvedTarget = resolve(targetPath)
  for (
    let child = resolvedTarget, parent = dirname(child);
    parent !== child;
    child = parent, parent = dirname(parent)
  ) {
    const insideRoots = await authorizeProjectPath(parent).catch(() => undefined)
    if (insideRoots === undefined) {
      continue
    }
    // A refused ordinary folder (e.g. an unregistered root's child) is not a link out of the project.
    const entry = await lstat(windowsFsPath(join(insideRoots, basename(child))))
    if (!entry.isSymbolicLink()) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return resolve(await realpathAcrossWslDriveMount(resolvedTarget))
  }
  throw new Error(PATH_ACCESS_DENIED_MESSAGE)
}
