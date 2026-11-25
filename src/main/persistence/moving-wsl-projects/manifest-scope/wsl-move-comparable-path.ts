/**
 * One spelling for a WSL folder across UNC aliases (`wsl$`, `wsl.localhost`), distro case, Linux
 * spelling and trailing separators, so the exit proof and the spawn fence agree on what is in scope.
 */
import {
  foldWslUncPathCaseInsensitiveParts,
  toWindowsWslUncPath
} from '../../../../shared/file-access/wsl-paths'
import {
  toWslDistroUncPath,
  type WslMappedDrive
} from '../../../../shared/wsl-move/wsl-mapped-drive-paths'

/** Null for a path that is not in a WSL distro (a Windows drive path no mapped drive covers). */
export function comparableWslPath(
  path: string,
  distro: string,
  mappedDrives: readonly WslMappedDrive[] = []
): string | null {
  const unc = isLinuxSpelled(path)
    ? toWindowsWslUncPath(path, distro)
    : toWslDistroUncPath(path, mappedDrives)
  return foldWslUncPathCaseInsensitiveParts(unc)?.replace(/\/+$/, '') ?? null
}

export function isLinuxSpelled(path: string): boolean {
  return /^\/(?!\/)/.test(path)
}

export function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}
