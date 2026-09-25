// WSL host path mapping (spec D5/D8): Orca holds WSL files in their Windows
// UNC form (`\\wsl.localhost\<distro>\home\u\a.cpp`); clangd runs inside the
// guest and answers in guest POSIX paths. The LSP document URI sent to clangd
// is the guest form (`file:///home/u/a.cpp`), and clangd's returned locations
// reverse-map back to the UNC form so Orca's editor opens them.
//
// These are pure functions (the distro is bound by the adapter) so they stay
// unit-testable: UNC with forward/back slashes, `\\wsl.localhost\\` vs the
// legacy `\\wsl$\\`, distro names with spaces, and drvfs (`/mnt/c/…`) tails.
import {
  parseWslUncPath,
  toLinuxPath,
  toWindowsWslUncPath,
  toWindowsWslDrivePath,
  foldWslUncPathCaseInsensitiveParts
} from '../../shared/wsl-paths'
import { normalizeNativeFilePath } from '../../shared/language-server-path-normalization'

/**
 * Canonical session/document key for a WSL file identity. Windows folds the
 * `wsl.localhost` share, the distro name, and any drvfs (`/mnt/c`) prefix
 * case-insensitively; the rest of the Linux path is case-sensitive. A drive
 * path (drvfs reached from Windows) falls back to native drive normalization.
 */
export function wslNormalizeKey(filePath: string): string {
  const folded = foldWslUncPathCaseInsensitiveParts(filePath)
  if (folded !== null) {
    return folded
  }
  return normalizeNativeFilePath(filePath)
}

/**
 * Orca file identity -> LSP document URI in guest form.
 * `\\wsl.localhost\Ubuntu\home\u\a b.cpp` -> `file:///home/u/a%20b.cpp`.
 * A drive path (`C:\…`) reached through a WSL session maps to its drvfs guest
 * path (`file:///mnt/c/…`) so clangd inside the guest can read it.
 */
export function wslPathToLspUri(filePath: string): string {
  const guestPath = toLinuxPath(filePath)
  const encoded = encodeURI(guestPath).replace(
    /[?#]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  // POSIX absolute paths carry their own leading slash (`file:///home/…`).
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
}

/**
 * LSP document URI -> Orca file identity (UNC form). clangd returns guest
 * paths (`file:///home/u/a.cpp`); reverse-map to the distro's UNC spelling so
 * Orca opens the file through its Windows identity. A drvfs URI
 * (`file:///mnt/c/…`) maps to the Windows drive (`C:\…`) — the file lives on
 * the drive whichever distro mounted it.
 */
export function wslLspUriToPath(uri: string, distro: string): string {
  const match = /^file:\/\/\/(.+)$/.exec(uri)
  if (!match) {
    throw new Error(`not a file: URI: ${uri}`)
  }
  const decoded = decodeURIComponent(match[1])
  const linuxPath = decoded.startsWith('/') ? decoded : `/${decoded}`
  // drvfs paths sit on the Windows drive regardless of distro.
  const drivePath = toWindowsWslDrivePath(linuxPath)
  if (drivePath !== null) {
    return normalizeNativeFilePath(drivePath)
  }
  return toWindowsWslUncPath(linuxPath, distro)
}

/** True when `path` is a WSL UNC path (the adapter selection predicate). */
export function isWslUncPath(path: string): boolean {
  return parseWslUncPath(path) !== null
}
