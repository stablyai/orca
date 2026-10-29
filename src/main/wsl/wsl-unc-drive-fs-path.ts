/**
 * WSL refuses Windows file access to its drive mounts over UNC: `\\wsl.localhost\<d>\mnt\c\x`
 * answers EPERM (WSL 2.7). The same folder opens through its drive path, `C:\x`.
 */
import { realpath as fsRealpath } from 'node:fs/promises'
import { parseWslUncPath, toWindowsWslDrivePath } from '../../shared/wsl-paths'

const WSL_UNC_PREFIX = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+/i
const DRIVE_PATH = /^([A-Za-z]):(?:[\\/](.*))?$/

/** The drive path Windows opens for a UNC path into a distro's drive mount; null for any other. */
export function wslUncDriveFsPath(
  path: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (platform !== 'win32') {
    return null
  }
  const info = parseWslUncPath(path)
  return info ? toWindowsWslDrivePath(info.linuxPath) : null
}

/** The path to hand to fs: the drive path for a UNC drive-mount path, else `path` itself. */
export function windowsFsPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return wslUncDriveFsPath(path, platform) ?? path
}

/**
 * realpath that resolves a UNC drive-mount path through its drive and answers in the caller's UNC
 * spelling, so allow-list checks against UNC roots are unchanged.
 */
export async function realpathAcrossWslDriveMount(
  path: string,
  deps: { realpath: (path: string) => Promise<string>; platform: NodeJS.Platform } = {
    realpath: fsRealpath,
    platform: process.platform
  }
): Promise<string> {
  const drive = wslUncDriveFsPath(path, deps.platform)
  if (!drive) {
    return deps.realpath(path)
  }
  const real = await deps.realpath(drive)
  const prefix = WSL_UNC_PREFIX.exec(path)?.[0]
  const match = DRIVE_PATH.exec(real)
  // A junction off the drive keeps its own spelling; authorization judges it as it is.
  if (!prefix || !match) {
    return real
  }
  const tail = match[2] ? `\\${match[2].replace(/\//g, '\\')}` : ''
  return `${prefix.replace(/\//g, '\\')}\\mnt\\${match[1].toLowerCase()}${tail}`
}
