import { realpathAcrossWslDriveMount, windowsFsPath } from '../wsl/wsl-unc-drive-fs-path'
import {
  canonicalizePathThroughFilesystemHost,
  requireFilesystemHostReadClient
} from './filesystem-host-read-client'
import { FilesystemHostReadError } from './filesystem-host-read-result'

export function canonicalizeAuthorizedPath(
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  return realpathAcrossWslDriveMount(path, {
    realpath: canonicalizePathThroughFilesystemHost,
    platform
  })
}
export async function isAuthorizedPathSymlink(
  path: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  const client = requireFilesystemHostReadClient()
  if (!client.isSymlink) {
    throw new FilesystemHostReadError('unavailable')
  }
  try {
    return await client.isSymlink(windowsFsPath(path, platform))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}
