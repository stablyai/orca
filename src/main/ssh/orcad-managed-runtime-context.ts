import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { getManagedOrcadOwnerEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { computeLocalOrcadBuildHash } from './orcad-local-build-hash'
import { probeActiveOrcadReadiness } from './orcad-active-readiness'
import { resolveOrcadRemoteContext, type OrcadRemoteContext } from './orcad-remote-context'
import type { OrcadDeployResult } from './orcad-remote-deploy'
import { resolveOrcadSlotNodeFallback } from './orcad-slot-runtime-eligibility'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'

export const ORCAD_BIND_HOST = '127.0.0.1'

export function requireManagedOrcadInfrastructure() {
  const targetStore = requireManagedOrcadTargetStore()
  const connectionManager = getSshConnectionManager()
  if (!connectionManager) {
    throw new Error('SSH is unavailable on this client; the managed Orca server is unverifiable.')
  }
  return { connectionManager, targetStore }
}

export function requireManagedOrcadTargetStore() {
  const targetStore = getSshTargetRegistryStore()
  if (!targetStore) {
    throw new Error('SSH target state is unavailable; migration readiness is unverifiable.')
  }
  return targetStore
}

export function requireManagedOrcadEnvironment(
  userDataPath: string,
  selector: string
): KnownRuntimeEnvironment {
  const environment = resolveEnvironment(userDataPath, selector)
  if (!environment.orcadDeployment || environment.connectionDependency !== 'ssh-tunnel') {
    throw new Error('This server is not managed through an orcad SSH deployment.')
  }
  return environment
}

export async function resolveLinkedOrcadContext(
  environment: KnownRuntimeEnvironment,
  signal?: AbortSignal
): Promise<OrcadRemoteContext> {
  const deployment = environment.orcadDeployment!
  const { connectionManager, targetStore } = requireManagedOrcadInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedOrcadOwnerEnvironmentId(target.owner) !== environment.id
  ) {
    throw new Error('The managed Orca server SSH registration is no longer valid.')
  }
  const connection = await connectionManager.connect(target)
  return resolveOrcadRemoteContext(target, connection, signal)
}

export function managedOrcadInstallDir(context: OrcadRemoteContext, version: string): string {
  return computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    context.remoteHome,
    version,
    context.host.pathFlavor
  )
}

export async function resolveActiveOrcadNodeFallback(
  context: OrcadRemoteContext,
  signal?: AbortSignal
): Promise<string | undefined> {
  return context.activationRecord.active
    ? resolveOrcadSlotNodeFallback(
        context.connection,
        context.host,
        managedOrcadInstallDir(context, context.activationRecord.active),
        signal
      )
    : undefined
}

export async function resolveOrcadDeployReadiness(
  context: OrcadRemoteContext,
  localOrcadDir: string,
  result: Exclude<OrcadDeployResult, { outcome: 'installed-not-activated' }>,
  activeNodePath: string | undefined,
  remotePort: number,
  signal?: AbortSignal
) {
  if (result.outcome === 'installed-and-activated') {
    return result.readiness
  }
  return probeActiveOrcadReadiness({
    conn: context.connection,
    host: context.host,
    remoteInstallDir: managedOrcadInstallDir(context, result.fullVersion),
    fullVersion: result.fullVersion,
    buildHash: computeLocalOrcadBuildHash(localOrcadDir),
    runtimeKind: activeNodePath ? 'node' : 'bun',
    ...(activeNodePath ? {} : { buildTarget: context.bunTarget }),
    port: remotePort,
    signal
  })
}

export function isForceableOrcadDeferral(code: string): boolean {
  return (
    code === 'orcad_update_terminals_running' || code === 'orcad_update_terminal_census_unavailable'
  )
}
