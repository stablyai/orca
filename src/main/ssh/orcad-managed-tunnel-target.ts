/** Opens a managed tunnel at the port orcad bound and keeps it only if orcad is what answers. */
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import {
  resolveManagedOrcadTunnelPort,
  type OrcadTunnelPortInput
} from './orcad-managed-bound-port'
import {
  OrcadManagedIdentityError,
  verifyManagedOrcadTunnelIdentity,
  type OrcadTunnelIdentity
} from './orcad-managed-tunnel-identity'
import type { SshConnection } from './ssh-connection'
import type { PortForwardEntry, SshPortForwardManager } from './ssh-port-forward'

export type OrcadManagedTunnelTargeting = {
  resolveRemotePort: (input: OrcadTunnelPortInput) => Promise<number>
  /** Checks the runtime the environment's pairing endpoint (the tunnel's local port) reaches. */
  verifyIdentity: (environment: KnownRuntimeEnvironment) => Promise<OrcadTunnelIdentity>
}

export const MANAGED_ORCAD_TUNNEL_TARGETING: OrcadManagedTunnelTargeting = {
  resolveRemotePort: resolveManagedOrcadTunnelPort,
  verifyIdentity: verifyManagedOrcadTunnelIdentity
}

/** Test default: the persisted port, and no identity round trip. */
export const PERSISTED_PORT_TARGETING: OrcadManagedTunnelTargeting = {
  resolveRemotePort: async ({ environment }) => getRuntimeSshAccess(environment)?.remotePort ?? 0,
  verifyIdentity: async () => ({ verdict: 'verified' })
}

export type VerifiedOrcadForwardArgs = {
  targetId: string
  connection: SshConnection
  forwards: SshPortForwardManager
  /** 0 picks a free local port. */
  localPort: number
  label: string
  remotePort: number
  /** Defaults to the same port, so a foreign answer fails at once. */
  rereadRemotePort?: () => Promise<number>
  /** Defaults to trusting the forward, for callers that verify on their own. */
  verify?: (localPort: number) => Promise<OrcadTunnelIdentity>
  stillCurrent: () => boolean
}

export type OrcadTunnelStartChecks = Pick<
  VerifiedOrcadForwardArgs,
  'rereadRemotePort' | 'verify'
> & {
  /** The persisted launch port, when the forward targets a port orcad fell back to. */
  preferredPort?: number
}

/** The manager's targeting, bound to one environment's tunnel, with the port it reads now. */
export async function environmentForwardChecks(
  targeting: OrcadManagedTunnelTargeting,
  input: OrcadTunnelPortInput
): Promise<Required<Pick<VerifiedOrcadForwardArgs, 'remotePort' | 'rereadRemotePort' | 'verify'>>> {
  return {
    remotePort: await targeting.resolveRemotePort(input),
    rereadRemotePort: () => targeting.resolveRemotePort(input),
    verify: () => targeting.verifyIdentity(input.environment)
  }
}

/**
 * Null when `stillCurrent` turned false mid-setup; the forward is already removed then.
 * An answer from another runtime re-reads the port once, since orcad may have restarted onto a
 * new one, and throws if the port did not move or the new one is foreign too.
 */
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
    if (identity.verdict !== 'foreign') {
      if (identity.verdict === 'unreachable') {
        // Why not fail: a server that is down or still starting is not a wrong server.
        console.warn(
          `[ssh] Managed Orca server did not answer through its tunnel: ${identity.detail}`
        )
      }
      return forward
    }
    await args.forwards.removeForwardAndWait(forward.id)
    const reread =
      attempt === 0 && args.rereadRemotePort ? await args.rereadRemotePort() : remotePort
    if (reread === remotePort || !args.stillCurrent()) {
      throw new OrcadManagedIdentityError(remotePort, identity.detail)
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
