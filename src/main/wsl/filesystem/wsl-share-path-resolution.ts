import { realpath, realpathSync } from 'node:fs'
import { promisify } from 'node:util'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'

const EXTENDED_UNC_PREFIX = /^[\\/]{2}\?[\\/]UNC[\\/]/i
const EXTENDED_DRIVE_PREFIX = /^[\\/]{2}\?[\\/](?=[A-Za-z]:)/
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
  const driveRoot = getDriveRoot(path, platform)
  if (!driveRoot) {
    return false
  }
  try {
    // Only the native call asks Windows for the final path; the JS one keeps the drive letter.
    return isWslSharePath(realpathSync.native(driveRoot))
  } catch {
    return false
  }
}

const realpathNative = promisify(realpath.native)

/** `resolvesIntoWslShare` without blocking the calling thread on the drive-root lookup. */
export async function resolvesIntoWslShareAsync(
  path: string,
  platform = process.platform
): Promise<boolean> {
  if (isWslSharePath(path)) {
    return true
  }
  const driveRoot = getDriveRoot(path, platform)
  if (!driveRoot) {
    return false
  }
  try {
    return isWslSharePath(await realpathNative(driveRoot))
  } catch {
    return false
  }
}

function getDriveRoot(path: string, platform: NodeJS.Platform): string | null {
  // `\\?\W:\...` is the extended spelling of a drive path.
  const drive =
    platform === 'win32' ? DRIVE_PATH.exec(path.replace(EXTENDED_DRIVE_PREFIX, '')) : null
  return drive ? `${drive[1]}:\\` : null
}
