import { isWslUncPath } from '../../shared/wsl-paths'
import type { FilesystemExecutionHost } from './filesystem-host-failure-domain'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'

const UNC_PATH_PREFIX = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/

export function routeFilesystemHostPath(
  path: string,
  defaultStorageClass: FilesystemStorageClass,
  platform: NodeJS.Platform
): { executionHost: FilesystemExecutionHost; storageClass: FilesystemStorageClass } {
  if (platform === 'win32' && isWslUncPath(path)) {
    return { executionHost: 'windows-host', storageClass: 'wsl' }
  }
  if (platform === 'win32' && UNC_PATH_PREFIX.test(path)) {
    return { executionHost: 'windows-host', storageClass: 'unc' }
  }
  return { executionHost: 'native', storageClass: defaultStorageClass }
}
