import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session/agent-session-host-authority'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { ptyIncarnationById } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'
import { agentSessionOwners, drainAgentSessionOwnerReconciliation } from './agent-session-owners'

const MAX_ROUTING_HOPS = 3

/** Unwraps routing containers only through their verified resolver, within the deadline. */
async function resolveAuthority(
  provider: IPtyProvider | undefined,
  id: string,
  incarnationId: string,
  deadline: number
): Promise<IPtyProvider | null> {
  let current: IPtyProvider | null = provider ?? null
  for (let hop = 0; current?.resolveAgentSessionAuthority && hop < MAX_ROUTING_HOPS; hop += 1) {
    const resolver = current.resolveAgentSessionAuthority(id, incarnationId)
    current = await Promise.race([
      resolver,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())).unref?.()
      )
    ])
  }
  return current?.resolveAgentSessionAuthority ? null : current
}

/** Removes one conversation's owner binding where it lives, keeping its terminal running: main's
 *  registry for an in-process PTY, the daemon (then main's copy) for a daemon PTY. True only on a
 *  positive acknowledgement for this exact binding and incarnation; an older daemon, an adopted
 *  owner, a lost reply or a spent deadline is false and the binding's meaning is unchanged. */
export async function releaseAgentSessionOwnerForFresh(input: {
  owner: AgentSessionOwnerBinding
  incarnationId: string | undefined
  deadline: number
}): Promise<boolean> {
  const { owner, incarnationId, deadline } = input
  const provider = incarnationId
    ? await resolveAuthority(
        tryGetProviderForPty(owner.ptyId),
        owner.ptyId,
        incarnationId,
        deadline
      )
    : null
  if (
    !provider ||
    !incarnationId ||
    Date.now() >= deadline ||
    agentSessionOwners.wasAdopted(owner)
  ) {
    return false
  }
  if (provider instanceof LocalPtyProvider) {
    return (
      ptyIncarnationById.get(owner.ptyId) === incarnationId &&
      agentSessionOwners.releaseExact(owner) !== 'refused'
    )
  }
  if (
    !provider.supportsAgentSessionClaimRelease?.(owner.ptyId) ||
    !provider.releaseAgentSessionClaim
  ) {
    return false
  }
  const released = await provider.releaseAgentSessionClaim(
    { id: owner.ptyId, expectedIncarnationId: incarnationId, owner },
    deadline - Date.now()
  )
  if (released.outcome !== 'released') {
    return false
  }
  // A listing taken before the release still names this owner; let it land, then drop main's copy.
  await drainAgentSessionOwnerReconciliation()
  return agentSessionOwners.releaseExact(owner) !== 'refused' && Date.now() <= deadline
}

/** Runs before an adopted or joined owner is returned, so a pending fresh decision can stand down. */
export function onAgentSessionOwnerAdopted(
  listener: (owner: AgentSessionOwnerBinding) => void
): () => void {
  return agentSessionOwners.onAdopted(listener)
}
