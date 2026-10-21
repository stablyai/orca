/** Connect and remove for hosts a desktop service owns (WSL); network hosts need neither. */
import { classifyRuntimeEnvironmentHost } from '../../../shared/runtime-environment-host-kind'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { getWslHostService } from '../../wsl/wsl-host-service-instance'

/** An explicit user connect; may boot a WSL host's distro. */
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

/** Null when no service owns the host, which leaves removal to the generic store path. */
export function removeThroughOwningService(
  environment: KnownRuntimeEnvironment
): Promise<unknown> | null {
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'wsl':
      // Also releases the distro's holder and drops the WSL record.
      return getWslHostService()?.remove(environment.id) ?? null
    case 'network':
      return null
  }
}
