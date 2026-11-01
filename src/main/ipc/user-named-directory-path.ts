import { isAbsolute, resolve } from 'node:path'
import { PATH_ACCESS_DENIED_MESSAGE } from './filesystem/filesystem-auth'
import {
  isDeviceNamespacePath,
  isNetworkSharePath,
  isWindowsReservedDeviceName
} from './automatic-load-path-text'
import { realpathAcrossWslDriveMount } from '../wsl/wsl-unc-drive-fs-path'

const USER_DIRECTORY_NEEDS_ABSOLUTE_PATH_MESSAGE =
  'Access denied: a directory opened by name needs an absolute path.'

function isRefusedDirectoryPath(directoryPath: string): boolean {
  return (
    isNetworkSharePath(directoryPath) ||
    isDeviceNamespacePath(directoryPath) ||
    isWindowsReservedDeviceName(directoryPath)
  )
}

/** A local directory the user chose for browsing: absolute, never a network share or device path. */
export async function resolveUserNamedDirectoryPath(targetPath: string): Promise<string> {
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    throw new Error(USER_DIRECTORY_NEEDS_ABSOLUTE_PATH_MESSAGE)
  }
  const resolvedTarget = resolve(targetPath)
  if (isRefusedDirectoryPath(resolvedTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const directoryPath = resolve(await realpathAcrossWslDriveMount(resolvedTarget))
  if (isRefusedDirectoryPath(directoryPath)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return directoryPath
}
