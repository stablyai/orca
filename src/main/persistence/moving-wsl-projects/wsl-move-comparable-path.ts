/**
 * One spelling for a WSL folder across UNC aliases (`wsl$`, `wsl.localhost`), distro case, Linux
 * spelling and trailing separators, so the exit proof and the spawn fence agree on what is in scope.
 */
import { foldWslUncPathCaseInsensitiveParts, toWindowsWslUncPath } from '../../../shared/wsl-paths'

/** Null for a path that is not in a WSL distro (a Windows drive path, say). */
export function comparableWslPath(path: string, distro: string): string | null {
  const unc = isLinuxSpelled(path) ? toWindowsWslUncPath(path, distro) : path
  return foldWslUncPathCaseInsensitiveParts(unc)?.replace(/\/+$/, '') ?? null
}

export function isLinuxSpelled(path: string): boolean {
  return /^\/(?!\/)/.test(path)
}

export function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}
