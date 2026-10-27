// Preferred ports may belong to other runtimes; tunnel to the active slot's published bound port.
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
import type { OrcadHostTarget, OrcadHostTransport } from '../../ssh/orcad-host-transport'

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

export async function readActiveManagedOrcadReadiness(input: {
  target: OrcadHostTarget
  connection: OrcadHostTransport
}): Promise<ServeReadiness | null> {
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

async function readActiveSlotBoundPort(input: OrcadTunnelPortInput): Promise<number | null> {
  if (!input.environment.orcadDeployment) {
    return null
  }
  const readiness = await readActiveManagedOrcadReadiness(input)
  return readiness ? orcadBoundPort(readiness) : null
}

export async function resolveManagedOrcadTunnelPort(input: OrcadTunnelPortInput): Promise<number> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    throw new Error('Managed orcad environment is missing its SSH tunnel dependency.')
  }
  try {
    return (await readActiveSlotBoundPort(input)) ?? access.remotePort
  } catch (error) {
    // Post-forward identity validation still detects a wrong server when falling back.
    console.warn(
      '[ssh] Could not read the managed Orca server port; trying the preferred one:',
      error
    )
    return access.remotePort
  }
}

/** Missing or unreadable published ports never justify moving an existing tunnel. */
export async function readManagedOrcadPublishedPort(
  input: OrcadTunnelPortInput
): Promise<number | null> {
  try {
    return await readActiveSlotBoundPort(input)
  } catch {
    return null
  }
}
