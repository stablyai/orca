/**
 * The port a managed orcad actually listens on. orcad asks for its preferred port but moves to a
 * free one when another runtime (a desktop Orca, `orca serve`) holds it, so a tunnel that assumed
 * the preferred port would reach that other runtime instead. The slot's readiness says which.
 */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { ServeReadiness } from '../server/serve-readiness'
import { managedOrcadInstallDir } from './orcad-managed-runtime-context'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import {
  parseOrcadReadinessWaitOutput,
  readOrcadReadinessNowCommand
} from './orcad-remote-readiness-wait'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import type { SshConnection } from './ssh-connection'

export type OrcadTunnelPortInput = {
  environment: KnownRuntimeEnvironment
  target: SshTarget
  connection: SshConnection
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

/** Falls back to the preferred port only when the slot published no endpoint (older builds). */
export async function readManagedOrcadBoundPort(
  target: OrcadRemoteExecTarget & { remoteInstallDir: string },
  preferredPort: number
): Promise<number> {
  const parsed = parseOrcadReadinessWaitOutput(
    target.host,
    await execOrcadRemote(
      target,
      readOrcadReadinessNowCommand(target.host, target.remoteInstallDir)
    )
  )
  return (parsed.state === 'ready' ? orcadBoundPort(parsed.readiness) : null) ?? preferredPort
}

/** Where a tunnel to this environment must point; independent SSH access keeps its own port. */
export async function resolveManagedOrcadTunnelPort(input: OrcadTunnelPortInput): Promise<number> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    throw new Error('Managed orcad environment is missing its SSH tunnel dependency.')
  }
  if (!input.environment.orcadDeployment) {
    return access.remotePort
  }
  try {
    const context = await resolveOrcadRemoteContext(input.target, input.connection)
    const active = context.activationRecord.active
    if (!active) {
      return access.remotePort
    }
    return await readManagedOrcadBoundPort(
      {
        conn: context.connection,
        host: context.host,
        remoteHome: context.remoteHome,
        remoteInstallDir: managedOrcadInstallDir(context, active)
      },
      access.remotePort
    )
  } catch (error) {
    // Why fall back: the identity check after the forward still catches a wrong server.
    console.warn(
      '[ssh] Could not read the managed Orca server port; trying the preferred one:',
      error
    )
    return access.remotePort
  }
}
