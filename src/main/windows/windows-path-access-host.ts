import { parseRoutableExecutionHostId } from '../../shared/execution-host'
import { windowsPathAccess, type WindowsPathAccess } from '../../shared/windows-path-access'
import { getWslHostService } from '../wsl/host-lifecycle/wsl-host-service-instance'

export async function resolveWindowsPathAccess(
  ownerHostId: unknown,
  platform: NodeJS.Platform = process.platform
): Promise<WindowsPathAccess | null> {
  if (typeof ownerHostId !== 'string') {
    return null
  }
  const host = parseRoutableExecutionHostId(ownerHostId)
  const distro =
    platform === 'win32' && host?.kind === 'runtime'
      ? ((await getWslHostService()?.recordForEnvironment(host.environmentId))?.distro ?? null)
      : null
  return windowsPathAccess(ownerHostId, {
    platform,
    wslDistroForEnvironment: () => distro
  })
}
