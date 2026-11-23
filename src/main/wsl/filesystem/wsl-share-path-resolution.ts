import { realpathSync } from 'node:fs'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'

const EXTENDED_UNC_PREFIX = /^[\\/]{2}\?[\\/]UNC[\\/]/i
const DRIVE_PATH = /^([A-Za-z]):(?:[\\/]|$)/

/** True when a path names a WSL share, including Windows' `\\?\UNC\wsl.localhost\...` spelling. */
export function isWslSharePath(path: string): boolean {
  return parseWslUncPath(path.replace(EXTENDED_UNC_PREFIX, '\\\\')) !== null
}

/** Also true for a drive letter mapped to a distro share (`net use W: \\wsl.localhost\Ubuntu`). */
export function resolvesIntoWslShare(path: string, platform = process.platform): boolean {
  if (isWslSharePath(path)) {
    return true
  }
  const drive = platform === 'win32' ? DRIVE_PATH.exec(path) : null
  if (!drive) {
    return false
  }
  try {
    // Only the native call asks Windows for the final path; the JS one keeps the drive letter.
    return isWslSharePath(realpathSync.native(`${drive[1]}:\\`))
  } catch {
    return false
  }
}
