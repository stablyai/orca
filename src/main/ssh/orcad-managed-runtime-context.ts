import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type {
  KnownRuntimeEnvironment,
  OrcadDeploymentLink
} from '../../shared/runtime-environments'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { ServeReadiness } from '../server/serve-readiness'
import { computeLocalOrcadBuildHash } from './orcad-local-build-hash'
import { probeActiveOrcadReadiness } from './orcad-active-readiness'
import { resolveOrcadRemoteContext, type OrcadRemoteContext } from './orcad-remote-context'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { getSshConnectionManager, getSshTargetRegistryStore } from './ssh-target-registry'

export const ORCAD_BIND_HOST = '127.0.0.1'

// Why empty: managed slots always carry their pinned runtime marker, so a marker-less slot
// fails to launch instead of silently running on whatever Node the host has.
export const MANAGED_ORCAD_LEGACY_NODE_PATH = ''

export function requireManagedOrcadInfrastructure() {
  const targetStore = requireManagedOrcadTargetStore()
  const connectionManager = getSshConnectionManager()
  if (!connectionManager) {
    throw new Error('SSH is unavailable on this client; the managed Orca server is unverifiable.')
  }
  return { connectionManager, targetStore, claims: targetStore.getOrcadRuntimeClaims() }
}

export function requireManagedOrcadTargetStore() {
  const targetStore = getSshTargetRegistryStore()
  if (!targetStore) {
    throw new Error('SSH target state is unavailable; the managed Orca server is unverifiable.')
  }
  return targetStore
}

export function requireManagedOrcadEnvironment(
  userDataPath: string,
  selector: string
): { environment: KnownRuntimeEnvironment; deployment: OrcadDeploymentLink } {
  const environment = resolveEnvironment(userDataPath, selector)
  const deployment = environment.orcadDeployment
  if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
    throw new Error('This server is not managed through an orcad SSH deployment.')
  }
  return { environment, deployment }
}

export async function resolveLinkedOrcadContext(
  environment: KnownRuntimeEnvironment,
  deployment: OrcadDeploymentLink,
  signal?: AbortSignal
): Promise<OrcadRemoteContext> {
  const { connectionManager, targetStore } = requireManagedOrcadInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedOrcadFenceEnvironmentId(target) !== environment.id
  ) {
    throw new Error('The managed Orca server SSH registration is no longer valid.')
  }
  const connection = await connectionManager.connect(target)
  return resolveOrcadRemoteContext(target, connection, signal)
}

/** The slot options every remote lifecycle step takes for this managed server. */
export function managedOrcadSlot(context: OrcadRemoteContext, port: number, signal?: AbortSignal) {
  return {
    conn: context.connection,
    host: context.host,
    remoteHome: context.remoteHome,
    nodePath: MANAGED_ORCAD_LEGACY_NODE_PATH,
    userDataDir: context.userDataDir,
    bindHost: ORCAD_BIND_HOST,
    port,
    signal
  }
}

export function managedOrcadInstallDir(context: OrcadRemoteContext, version: string): string {
  return computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    context.remoteHome,
    version,
    context.host.pathFlavor
  )
}

/** The active slot's readiness, accepted only if it is the build this client holds. */
export function probeManagedOrcadReadiness(
  context: OrcadRemoteContext,
  localOrcadDir: string,
  fullVersion: string,
  signal?: AbortSignal
): Promise<ServeReadiness> {
  return probeActiveOrcadReadiness(
    {
      conn: context.connection,
      host: context.host,
      remoteInstallDir: managedOrcadInstallDir(context, fullVersion),
      signal
    },
    { buildHash: computeLocalOrcadBuildHash(localOrcadDir), fullVersion }
  )
}

// Why only this code: deploy never has a session count to force past, so forcing an unknown
// census lands on the daemon-protocol deferral, which force cannot clear.
export function isForceableOrcadDeferral(code: string): boolean {
  return code === 'orcad_update_terminals_running'
}
