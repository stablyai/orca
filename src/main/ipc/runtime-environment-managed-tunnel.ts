import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { ensureOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'

export async function resolveManagedRuntimeEnvironment(
  userDataPath: string,
  selector: string
): Promise<ReturnType<typeof resolveEnvironment>> {
  const environment = resolveEnvironment(userDataPath, selector)
  await ensureOrcadManagedTunnel(userDataPath, environment.id)
  return resolveEnvironment(userDataPath, environment.id)
}
