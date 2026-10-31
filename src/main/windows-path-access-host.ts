import { windowsPathAccess, type WindowsPathAccess } from '../shared/windows-path-access'
import { getWslHostService } from './wsl/wsl-host-service-instance'

export function resolveWindowsPathAccess(
  ownerHostId: unknown,
  platform: NodeJS.Platform = process.platform
): WindowsPathAccess | null {
  if (typeof ownerHostId !== 'string') {
    return null
  }
  return windowsPathAccess(ownerHostId, {
    platform,
    wslDistroForEnvironment: (environmentId) =>
      getWslHostService()?.recordForEnvironment(environmentId)?.distro ?? null
  })
}
