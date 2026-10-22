/** The managed tunnels a client holds, and the one rule for whether one still belongs to its server. */
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment,
  type RuntimeSshTunnelLink
} from '../../../shared/runtime-environments'
import type { PortForwardEntry, SshTarget } from '../../../shared/ssh-types'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import { adoptSshConnection } from '../../ssh/connection/ssh-connection-attribution'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'

export type ActiveOrcadTunnel = {
  connection: SshConnection
  forwardId: string
  localPort: number
  /** The port orcad bound, which can differ from the persisted (preferred) one. */
  remotePort: number
  preferredPort: number
  sshTargetGeneration: number
  targetId: string
  transportGeneration: number
}

type ManagedTunnelExpectation = {
  environmentId: string
  sshTargetId: string
  sshTargetGeneration: number
  localPort: number
  remotePort: number
}

/** The environment's SSH access while it and its target still name this tunnel; null otherwise. */
export function managedTunnelAccess(
  environment: KnownRuntimeEnvironment | null | undefined,
  target: SshTarget | null | undefined,
  expected: ManagedTunnelExpectation
): RuntimeSshTunnelLink | null {
  const access = environment ? getRuntimeSshAccess(environment) : undefined
  return environment?.id === expected.environmentId &&
    environment.connectionDependency === 'ssh-tunnel' &&
    access?.sshTargetId === expected.sshTargetId &&
    access.sshTargetGeneration === expected.sshTargetGeneration &&
    access.localPort === expected.localPort &&
    access.remotePort === expected.remotePort &&
    target?.generation === expected.sshTargetGeneration &&
    getManagedOrcadFenceEnvironmentId(target) === expected.environmentId
    ? access
    : null
}

/** The build's environment is still the same pairing, with an SSH tunnel it may use. */
export function managedTunnelStillPaired(
  built: KnownRuntimeEnvironment,
  current: KnownRuntimeEnvironment | null,
  target: SshTarget | null | undefined,
  expected: ManagedTunnelExpectation
): boolean {
  return (
    current?.runtimeId === built.runtimeId &&
    (current.pairingRevision ?? current.createdAt) === (built.pairingRevision ?? built.createdAt) &&
    managedTunnelAccess(current, target, expected) !== null
  )
}

/** The SSH target and transport a managed environment's tunnel must use, or why it cannot. */
export function resolveManagedTunnelBinding(
  environment: KnownRuntimeEnvironment,
  dependencies: {
    getConnectionManager: () => SshConnectionManager | null
    getTargetStore: () => ReturnType<typeof getSshTargetRegistryStore>
  }
): {
  deployment: RuntimeSshTunnelLink
  targetStore: NonNullable<ReturnType<typeof getSshTargetRegistryStore>>
  connectionManager: SshConnectionManager
  target: SshTarget
} {
  const deployment = getRuntimeSshAccess(environment)
  if (!deployment || environment.connectionDependency !== 'ssh-tunnel') {
    throw new Error('Managed orcad environment is missing its SSH tunnel dependency.')
  }
  const targetStore = dependencies.getTargetStore()
  const connectionManager = dependencies.getConnectionManager()
  if (!targetStore || !connectionManager) {
    throw new Error('SSH is unavailable on this client; this host’s Orca server is unverifiable.')
  }
  const target = targetStore.getTarget(deployment.sshTargetId)
  if (!target || target.generation !== deployment.sshTargetGeneration) {
    throw new Error('The SSH registration for this host’s Orca server was removed or re-created.')
  }
  if (getManagedOrcadFenceEnvironmentId(target) !== environment.id) {
    throw new Error('The SSH target is no longer owned by this host’s Orca server.')
  }
  return { deployment, targetStore, connectionManager, target }
}

/** Removes `entry`'s forward, and the record only if nothing replaced it meanwhile. */
export async function dropActiveOrcadTunnel(
  active: Map<string, ActiveOrcadTunnel>,
  forwards: SshPortForwardManager,
  environmentId: string,
  entry: ActiveOrcadTunnel
): Promise<void> {
  await forwards.removeForwardAndWait(entry.forwardId)
  if (active.get(environmentId) === entry) {
    active.delete(environmentId)
  }
}

/** The recorded tunnel already rides this transport to this deployment, so a build can reuse it. */
export function activeTunnelMatches(
  active: ActiveOrcadTunnel | undefined,
  current: {
    connection: SshConnection
    transportGeneration: number
    target: SshTarget
    deployment: RuntimeSshTunnelLink
  }
): boolean {
  return (
    active?.connection === current.connection &&
    active.transportGeneration === current.transportGeneration &&
    active.targetId === current.target.id &&
    active.sshTargetGeneration === current.target.generation &&
    active.localPort === current.deployment.localPort &&
    active.preferredPort === current.deployment.remotePort
  )
}

export function recordActiveOrcadTunnel(
  active: Map<string, ActiveOrcadTunnel>,
  environmentId: string,
  forward: PortForwardEntry,
  tunnel: Omit<ActiveOrcadTunnel, 'forwardId' | 'localPort' | 'remotePort'>
): void {
  // The tunnel now relies on this transport, so a cancelled connect that opened it must keep it.
  adoptSshConnection(tunnel.connection)
  active.set(environmentId, {
    ...tunnel,
    forwardId: forward.id,
    localPort: forward.localPort,
    remotePort: forward.remotePort
  })
}

/** A run a close(), ownership change or transport change overtook: it must not read as success. */
class OrcadTunnelSupersededError extends Error {
  constructor() {
    super('Orca SSH tunnel setup was superseded.')
    this.name = 'OrcadTunnelSupersededError'
  }
}

export function supersededTunnelError(): Error {
  return new OrcadTunnelSupersededError()
}
