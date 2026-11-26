/** `orca environment forget` for a WSL host: drop it without contacting its distro (#49180). */
import { classifyRuntimeEnvironmentHost } from '../../../shared/remote-runtime/host-catalog/runtime-environment-host-kind'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { OrcadManagedForgetResult } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import { assertWslHostReachable } from '../../wsl/host-lifecycle/wsl-host-gate'
import { getWslHostService } from '../../wsl/host-lifecycle/wsl-host-service-instance'

/** Null for any server that isn't a WSL host, which the SSH forget then handles. */
export async function forgetWslHostEnvironment(
  userDataPath: string,
  selector: string,
  policy: { isActiveEnvironment: (environmentId: string) => boolean }
): Promise<OrcadManagedForgetResult | null> {
  const environment = await resolveEnvironment(userDataPath, selector)
  if (classifyRuntimeEnvironmentHost(environment).kind !== 'wsl') {
    return null
  }
  if (policy.isActiveEnvironment(environment.id)) {
    return {
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_forget_active_environment',
      reason:
        'This server is the default host for new projects. Choose another one under New projects open on before forgetting it.'
    }
  }
  assertWslHostReachable(environment)
  const service = getWslHostService()
  if (!service) {
    throw new Error('WSL hosts are not available on this computer.')
  }
  await service.remove(environment.id, true)
  return { outcome: 'forgotten', verdict: 'unverifiable', environmentId: environment.id }
}
