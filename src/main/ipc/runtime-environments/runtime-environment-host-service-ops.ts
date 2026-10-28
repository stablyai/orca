import { classifyRuntimeEnvironmentHost } from '../../../shared/runtime-environment-host-kind'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { WslHostServerStop } from '../../../shared/wsl-host-types'
import { getWslHostService } from '../../wsl/wsl-host-service-instance'

/** Explicit connection may boot the WSL distro. */
export async function connectThroughOwningService(
  environment: KnownRuntimeEnvironment
): Promise<void> {
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'wsl':
      await getWslHostService()?.connect(environment.id)
      break
    case 'network':
      break
  }
}

/** Null delegates removal to the generic store path. */
export function removeThroughOwningService(
  environment: KnownRuntimeEnvironment
): Promise<WslHostServerStop> | null {
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'wsl':
      // Also releases the distro's holder and drops the WSL record.
      return getWslHostService()?.remove(environment.id) ?? null
    case 'network':
      return null
  }
}
