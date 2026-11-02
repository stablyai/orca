import type { AgentSessionOwnerBinding } from '../../../../shared/agent-session/agent-session-host-authority'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import { ptyIncarnationById } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'
import { agentSessionOwners, drainAgentSessionOwnerReconciliation } from './agent-session-owners'

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
  const provider = tryGetProviderForPty(owner.ptyId)
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
