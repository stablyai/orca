import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment,
  type OrcadSshDeploymentLink
} from '../../../shared/runtime-environments'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import type { ServeReadiness } from '../../server/serve-readiness'
import { computeLocalOrcadBuildHash } from '../../ssh/orcad-local-build-hash'
import { sshOrcadHostTransport } from '../../ssh/orcad-ssh-host-transport'
import type { OrcadHostTarget } from '../../ssh/orcad-host-transport'
import type { OrcadActivationRecord } from '../activation/orcad-activation-record'
import { admitOrcadRecordForIntent, type OrcadUpdateIntent } from './orcad-managed-update-decision'
import {
  type OrcadTerminalCensus,
  UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
} from '../../../shared/orcad-terminal-census'
import { probeActiveOrcadReadiness } from '../../ssh/orcad-active-readiness'
import { resolveOrcadRemoteContext, type OrcadRemoteContext } from '../install/orcad-remote-context'
import { ORCAD_INSTALL_MODEL } from '../install/remote-install-model'
import { computeRemoteInstallDir } from '../install/remote-versioned-install'
import {
  getSshConnectionManager,
  getSshTargetRegistryStore
} from '../../ssh/targets/ssh-target-registry'

const ORCAD_BIND_HOST = '127.0.0.1'

// Pinned slots must fail on absent markers rather than silently use host Node.
const MANAGED_ORCAD_LEGACY_NODE_PATH = ''

export function requireManagedOrcadInfrastructure() {
  const targetStore = requireManagedOrcadTargetStore()
  const connectionManager = getSshConnectionManager()
  if (!connectionManager) {
    throw new Error('SSH is unavailable on this client; this host’s Orca server is unverifiable.')
  }
  return { connectionManager, targetStore, claims: targetStore.getOrcadRuntimeClaims() }
}

export function requireManagedOrcadTargetStore() {
  const targetStore = getSshTargetRegistryStore()
  if (!targetStore) {
    throw new Error('SSH target state is unavailable; this host’s Orca server is unverifiable.')
  }
  return targetStore
}

export function requireManagedOrcadEnvironment(
  userDataPath: string,
  selector: string
): { environment: KnownRuntimeEnvironment; deployment: OrcadSshDeploymentLink } {
  const environment = resolveEnvironment(userDataPath, selector)
  const deployment = getOrcadSshDeployment(environment)
  if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
    throw new Error('This server is not managed through an orcad SSH deployment.')
  }
  return { environment, deployment }
}

export async function resolveLinkedOrcadContext(
  environment: KnownRuntimeEnvironment,
  deployment: OrcadSshDeploymentLink,
  signal?: AbortSignal
): Promise<OrcadRemoteContext> {
  const { connectionManager, targetStore } = requireManagedOrcadInfrastructure()
  const target = targetStore.getTarget(deployment.sshTargetId)
  if (
    !target ||
    target.generation !== deployment.sshTargetGeneration ||
    getManagedOrcadFenceEnvironmentId(target) !== environment.id
  ) {
    throw new Error('The SSH registration for this host’s Orca server is no longer valid.')
  }
  const connection = await connectionManager.connect(target)
  return resolveOrcadRemoteContext(target, sshOrcadHostTransport(connection), signal)
}

export function managedOrcadSlot(
  context: OrcadRemoteContext<OrcadHostTarget>,
  port: number,
  signal?: AbortSignal
) {
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

export function managedOrcadInstallDir(
  context: OrcadRemoteContext<OrcadHostTarget>,
  version: string
): string {
  return computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    context.remoteHome,
    version,
    context.host.pathFlavor
  )
}

/** Accept readiness only from the build this client holds. */
export function probeManagedOrcadReadiness(
  context: OrcadRemoteContext<OrcadHostTarget>,
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

export function managedOrcadDeployPolicy(
  context: Pick<OrcadRemoteContext<OrcadHostTarget>, 'activationRecord'>,
  appVersion: string,
  intent: OrcadUpdateIntent
): {
  census: OrcadTerminalCensus
  recountCensus: () => Promise<OrcadTerminalCensus>
  releaseIncumbentAdmission: () => Promise<void>
  censusRecord: OrcadActivationRecord
  admitRecord: (record: OrcadActivationRecord, candidateVersion: string) => string | null
} {
  // Only the active daemon can count sessions; guessing zero risks restarting live terminals.
  const census: OrcadTerminalCensus = context.activationRecord.active
    ? UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
    : { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  return {
    census,
    recountCensus: async () => census,
    releaseIncumbentAdmission: async () => {},
    censusRecord: context.activationRecord,
    // Only the fenced read can reject newer migrated state or rolled-back builds on this unlinked path.
    admitRecord: admitOrcadRecordForIntent(intent, appVersion)
  }
}

// Force can override live terminal counts, never unknown census or protocol deferrals.
export function isForceableOrcadDeferral(code: string): boolean {
  return code === 'orcad_update_terminals_running'
}
