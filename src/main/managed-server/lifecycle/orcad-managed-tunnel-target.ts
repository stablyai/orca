import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import {
  readManagedOrcadPublishedPort,
  resolveManagedOrcadTunnelPort,
  type OrcadTunnelPortInput
} from './orcad-managed-bound-port'
import {
  orcadIdentityRefusal,
  verifyManagedOrcadTunnelIdentity,
  type OrcadTunnelIdentity
} from './orcad-managed-tunnel-identity'
import { managedOrcadSlot } from './orcad-managed-runtime-context'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { resolveOrcadRemoteContext } from '../install/orcad-remote-context'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { PortForwardEntry } from '../../../shared/ssh-types'
import type { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'

export type OrcadManagedTunnelTargeting = {
  resolveRemotePort: (input: OrcadTunnelPortInput) => Promise<number>
  verifyIdentity: (environment: KnownRuntimeEnvironment) => Promise<OrcadTunnelIdentity>
  /** Wake only proven-stopped slots before rereading ports after foreign answers. */
  wakeStoppedServer?: (input: OrcadTunnelPortInput) => Promise<void>
  readPublishedPort?: (input: OrcadTunnelPortInput) => Promise<number | null>
}

export const MANAGED_ORCAD_TUNNEL_TARGETING: OrcadManagedTunnelTargeting = {
  resolveRemotePort: resolveManagedOrcadTunnelPort,
  verifyIdentity: verifyManagedOrcadTunnelIdentity,
  wakeStoppedServer: wakeStoppedManagedOrcadForTunnel,
  readPublishedPort: readManagedOrcadPublishedPort
}

// Stopped slots may have lost their port; waking publishes a new free port for the reread.
async function wakeStoppedManagedOrcadForTunnel(input: OrcadTunnelPortInput): Promise<void> {
  const access = getRuntimeSshAccess(input.environment)
  if (!access) {
    return
  }
  try {
    const context = await resolveOrcadRemoteContext(input.target, input.connection)
    await wakeStoppedManagedOrcad(managedOrcadSlot(context, access.remotePort))
  } catch (error) {
    // Failed wake does not settle identity; reread and validate the resulting forward.
    console.warn('[ssh] Could not start the managed Orca server behind a foreign answer:', error)
  }
}

/** Tests may trust persisted ports without an identity round trip. */
export const PERSISTED_PORT_TARGETING: OrcadManagedTunnelTargeting = {
  resolveRemotePort: async ({ environment }) => getRuntimeSshAccess(environment)?.remotePort ?? 0,
  verifyIdentity: async () => ({ verdict: 'verified' })
}

type VerifiedOrcadForwardArgs = {
  targetId: string
  connection: SshConnection
  forwards: SshPortForwardManager
  localPort: number
  label: string
  remotePort: number
  /** Without a reread, foreign answers fail immediately. */
  rereadRemotePort?: () => Promise<number>
  /** Omit when the caller validates identity itself. */
  verify?: (localPort: number) => Promise<OrcadTunnelIdentity>
  stillCurrent: () => boolean
}

export type OrcadTunnelStartChecks = Pick<
  VerifiedOrcadForwardArgs,
  'rereadRemotePort' | 'verify'
> & {
  /** Persisted preferred port when the server bound elsewhere. */
  preferredPort?: number
}

export async function environmentForwardChecks(
  targeting: OrcadManagedTunnelTargeting,
  input: OrcadTunnelPortInput
): Promise<Required<Pick<VerifiedOrcadForwardArgs, 'remotePort' | 'rereadRemotePort' | 'verify'>>> {
  return {
    remotePort: await targeting.resolveRemotePort(input),
    rereadRemotePort: async () => {
      await targeting.wakeStoppedServer?.(input)
      return targeting.resolveRemotePort(input)
    },
    verify: () => targeting.verifyIdentity(input.environment)
  }
}

/** Remove superseded forwards; retry foreign ports once. Pinned-server token refusals fail immediately. */
export async function forwardToVerifiedOrcad(
  args: VerifiedOrcadForwardArgs
): Promise<PortForwardEntry | null> {
  let remotePort = args.remotePort
  for (let attempt = 0; ; attempt++) {
    const forward = await addCurrentForward(args, remotePort)
    if (!forward) {
      return null
    }
    const identity = args.verify
      ? await args.verify(forward.localPort)
      : ({ verdict: 'verified' } as const)
    if (!args.stillCurrent()) {
      await args.forwards.removeForwardAndWait(forward.id)
      return null
    }
    if (identity.verdict === 'verified' || identity.verdict === 'unreachable') {
      if (identity.verdict === 'unreachable') {
        // Unreachable servers may be down or starting; this is not proof of a foreign server.
        console.warn(
          `[ssh] Managed Orca server did not answer through its tunnel: ${identity.detail}`
        )
      }
      return forward
    }
    await args.forwards.removeForwardAndWait(forward.id)
    // Token refusal from our pinned server is not a moved port; waking cannot repair pairing.
    if (identity.verdict === 'unpaired') {
      throw orcadIdentityRefusal(remotePort, identity)
    }
    const reread =
      attempt === 0 && args.rereadRemotePort ? await args.rereadRemotePort() : remotePort
    if (reread === remotePort || !args.stillCurrent()) {
      throw orcadIdentityRefusal(remotePort, identity)
    }
    remotePort = reread
  }
}

async function addCurrentForward(
  args: VerifiedOrcadForwardArgs,
  remotePort: number
): Promise<PortForwardEntry | null> {
  const forward = await args.forwards.addForward(
    args.targetId,
    args.connection,
    args.localPort,
    '127.0.0.1',
    remotePort,
    args.label
  )
  if (args.localPort !== 0 && forward.localPort !== args.localPort) {
    await args.forwards.removeForwardAndWait(forward.id)
    throw new Error('Managed Orca tunnel bound an unexpected local port.')
  }
  if (!args.stillCurrent()) {
    await args.forwards.removeForwardAndWait(forward.id)
    return null
  }
  return forward
}
