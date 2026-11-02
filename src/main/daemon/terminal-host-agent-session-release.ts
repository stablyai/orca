import type { AgentSessionClaimReleaseOutcome } from '../../shared/agent-session-claim-release'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session/agent-session-host-authority'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { Session } from './session'

/** Releases one conversation claim of a live terminal without touching the terminal itself. An
 *  already-absent binding is acknowledged only for the same live incarnation with no start pending. */
export function releaseTerminalHostAgentSessionClaim(
  request: { sessionId: string; expectedIncarnationId: string; owner: AgentSessionOwnerBinding },
  deps: {
    sessions: ReadonlyMap<string, Session>
    pendingCreations: ReadonlyMap<string, unknown>
    owners: ClaimedAgentPtyOwnerRegistry
  }
): AgentSessionClaimReleaseOutcome {
  const session = deps.sessions.get(request.sessionId)
  if (
    !session ||
    !session.isAlive ||
    session.incarnationId !== request.expectedIncarnationId ||
    request.owner.ptyId !== request.sessionId
  ) {
    return { outcome: 'refused', reason: 'replaced' }
  }
  if (deps.pendingCreations.has(request.sessionId)) {
    return { outcome: 'refused', reason: 'pending' }
  }
  return deps.owners.releaseExact(request.owner) === 'refused'
    ? { outcome: 'refused', reason: 'owner' }
    : { outcome: 'released' }
}
