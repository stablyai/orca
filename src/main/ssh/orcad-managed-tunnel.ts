import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'
import { probeManagedOrcadTunnel } from './orcad-managed-tunnel-resume'
import { ensureManagedOrcadServing } from './orcad-managed-serving'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'
import {
  MANAGED_ORCAD_TUNNEL_TARGETING,
  type OrcadTunnelStartChecks
} from './orcad-managed-tunnel-target'

export { OrcadManagedTunnelManager } from './orcad-managed-tunnel-manager'

const managedTunnels = new OrcadManagedTunnelManager({
  getConnectionManager: getSshConnectionManager,
  getTargetStore: getSshTargetRegistryStore,
  targeting: MANAGED_ORCAD_TUNNEL_TARGETING,
  ensureServing: (input) => ensureManagedOrcadServing({ ...input, probe: probeManagedOrcadTunnel })
})

export async function ensureOrcadManagedTunnel(
  userDataPath: string,
  selector: string
): Promise<void> {
  const environment = resolveEnvironment(userDataPath, selector)
  await managedTunnels.ensure(environment, () =>
    resolveEnvironmentOrNull(userDataPath, environment.id)
  )
}

function resolveEnvironmentOrNull(userDataPath: string, id: string) {
  try {
    return resolveEnvironment(userDataPath, id)
  } catch {
    return null
  }
}

export function verifyManagedTunnelServing(environment: KnownRuntimeEnvironment) {
  return managedTunnels.verifyServing(environment)
}

export function disposeOrcadManagedTunnels(): void {
  managedTunnels.dispose()
}

export function recoverOrcadManagedTunnelsAfterHostResume(
  userDataPath: string,
  options: { attempts: number; timeoutMs: number }
): Promise<void> {
  return managedTunnels.recoverAfterHostResume({
    ...options,
    resolveEnvironment: (environmentId) => resolveEnvironmentOrNull(userDataPath, environmentId)
  })
}

export function startOrcadManagedTunnel(
  environmentId: string,
  target: SshTarget,
  connection: SshConnection,
  remotePort: number,
  checks?: OrcadTunnelStartChecks
): Promise<number> {
  return managedTunnels.start(environmentId, target, connection, remotePort, checks)
}

export function closeOrcadManagedTunnel(environmentId: string): Promise<void> {
  return managedTunnels.close(environmentId)
}
