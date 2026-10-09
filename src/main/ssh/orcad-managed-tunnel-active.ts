/** The managed tunnels a client holds, and the one rule for whether one still belongs to its server. */
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment,
  type RuntimeSshTunnelLink
} from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'
import { adoptSshConnection } from './ssh-connection-attribution'
import type { PortForwardEntry, SshPortForwardManager } from './ssh-port-forward'

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

export type ManagedTunnelExpectation = {
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
export class OrcadTunnelSupersededError extends Error {
  constructor() {
    super('Orca SSH tunnel setup was superseded.')
    this.name = 'OrcadTunnelSupersededError'
  }
}

export function supersededTunnelError(): Error {
  return new OrcadTunnelSupersededError()
}
