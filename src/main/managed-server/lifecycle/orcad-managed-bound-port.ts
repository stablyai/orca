/**
 * The port a managed orcad actually listens on. orcad asks for its preferred port but moves to a
 * free one when another runtime (a desktop Orca, `orca serve`) holds it, so a tunnel that assumed
 * the preferred port would reach that other runtime instead. The slot's readiness says which.
 */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import type { SshTarget } from '../../../shared/ssh-types'
import type { ServeReadiness } from '../../server/serve-readiness'
import { managedOrcadInstallDir } from './orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from '../install/orcad-remote-context'
import {
  parseOrcadReadinessWaitOutput,
  readOrcadReadinessNowCommand
} from '../install/orcad-remote-readiness-wait'
import {
  execOrcadRemote,
  type OrcadRemoteExecTarget
} from '../install/orcad-remote-runtime-control'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'

export type OrcadTunnelPortInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: OrcadHostTransport
}

export function orcadBoundPort(readiness: Pick<ServeReadiness, 'boundEndpoint'>): number | null {
  if (!readiness.boundEndpoint) {
    return null
  }
  try {
    const port = Number(new URL(readiness.boundEndpoint).port)
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
  } catch {
    return null
  }
}

async function readManagedOrcadSlotReadiness(
  target: OrcadRemoteExecTarget & { remoteInstallDir: string }
): Promise<ServeReadiness | null> {
  const parsed = parseOrcadReadinessWaitOutput(
    target.host,
    await execOrcadRemote(
      target,
      readOrcadReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return parsed.state === 'ready' ? parsed.readiness : null
}

async function readSlotBoundPort(
  target: OrcadRemoteExecTarget & { remoteInstallDir: string }
): Promise<number | null> {
  const readiness = await readManagedOrcadSlotReadiness(target)
  return readiness ? orcadBoundPort(readiness) : null
}

/** Falls back to the preferred port only when the slot published no endpoint (older builds). */
export async function readManagedOrcadBoundPort(
  target: OrcadRemoteExecTarget & { remoteInstallDir: string },
  preferredPort: number
): Promise<number> {
  return (await readSlotBoundPort(target)) ?? preferredPort
}

/** What the active slot publishes now, read over SSH; null when none is active or ready. */
export async function readActiveManagedOrcadReadiness(
  input: Pick<OrcadTunnelPortInput, 'target' | 'connection'>
): Promise<ServeReadiness | null> {
  const context = await resolveOrcadRemoteContext(input.target, input.connection)
  const active = context.activationRecord.active
  if (!active) {
    return null
  }
  return readManagedOrcadSlotReadiness({
    conn: context.connection,
    host: context.host,
    remoteHome: context.remoteHome,
    remoteInstallDir: managedOrcadInstallDir(context, active)
  })
}

/** The bound port the active slot's readiness names now; null when it names none. */
async function readActiveSlotBoundPort(input: OrcadTunnelPortInput): Promise<number | null> {
  if (!input.environment.orcadDeployment) {
    return null
  }
  const readiness = await readActiveManagedOrcadReadiness(input)
  return readiness ? orcadBoundPort(readiness) : null
}

/** Where a tunnel to this environment must point; independent SSH access keeps its own port. */
export async function resolveManagedOrcadTunnelPort(input: OrcadTunnelPortInput): Promise<number> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    throw new Error('Managed orcad environment is missing its SSH tunnel dependency.')
  }
  try {
    return (await readActiveSlotBoundPort(input)) ?? access.remotePort
  } catch (error) {
    // Why fall back: the identity check after the forward still catches a wrong server.
    console.warn(
      '[ssh] Could not read the managed Orca server port; trying the preferred one:',
      error
    )
    return access.remotePort
  }
}

/**
 * The port the host says its server is bound to now, whichever desktop restarted it; null when
 * the host names none (older builds) or cannot be read, which is never a reason to move a tunnel.
 */
export async function readManagedOrcadPublishedPort(
  input: OrcadTunnelPortInput
): Promise<number | null> {
  try {
    return await readActiveSlotBoundPort(input)
  } catch {
    return null
  }
}
