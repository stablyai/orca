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

// Why empty: managed slots always carry their pinned runtime marker, so a marker-less slot
// fails to launch instead of silently running on whatever Node the host has.
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

/** The slot options every remote lifecycle step takes for this managed server. */
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

/** The active slot's readiness, accepted only if it is the build this client holds. */
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

/** The census and version admission every first deploy onto a host applies, SSH or WSL. */
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
  // Why unknown when a version is active: only the daemon can count its sessions, and
  // a deploy that guessed zero would restart over live terminals.
  const census: OrcadTerminalCensus = context.activationRecord.active
    ? UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
    : { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
  return {
    census,
    recountCensus: async () => census,
    // Nothing was fenced: this recount never asks the server.
    releaseIncumbentAdmission: async () => {},
    censusRecord: context.activationRecord,
    // Why the intent's plan: a host another desktop stopped may hold state its newer build
    // migrated, and a build the host rolled back from must not return on a connect; this path has
    // no linked record to check first, so only the fenced read can refuse.
    admitRecord: admitOrcadRecordForIntent(intent, appVersion)
  }
}

// Why only this code: deploy never has a session count to force past, so forcing an unknown
// census lands on the daemon-protocol deferral, which force cannot clear.
export function isForceableOrcadDeferral(code: string): boolean {
  return code === 'orcad_update_terminals_running'
}
