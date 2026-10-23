import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../shared/pty-fenced-termination'
import type { Session } from './session'
import type { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'

type FencedTermination =
  | { accepted: false; result: PtyFencedTerminationOutcome }
  | { accepted: true; completion: Promise<PtyFencedTerminationOutcome> }

export function beginTerminalHostFencedTermination(
  request: PtyFencedTerminationRequest,
  deps: {
    sessions: ReadonlyMap<string, Session>
    pendingCreations: ReadonlyMap<string, Promise<void>>
    owners: ClaimedAgentPtyOwnerRegistry
    kill: (id: string, options: { immediate: true }) => Promise<void>
  }
): FencedTermination {
  const session = deps.sessions.get(request.id)
  if (!session || !session.isAlive) {
    return { accepted: false, result: { outcome: 'already_exited' } }
  }
  if (session.incarnationId !== request.expectedIncarnationId) {
    return { accepted: false, result: { outcome: 'refused', reason: 'replaced' } }
  }
  // Pending creates include claim reservation and promotion, before the owner is listed.
  if (deps.pendingCreations.has(request.id)) {
    return { accepted: false, result: { outcome: 'refused', reason: 'claimed' } }
  }
  if (request.requireNoAgentOwner && deps.owners.listForPty(request.id).length > 0) {
    return { accepted: false, result: { outcome: 'refused', reason: 'claimed' } }
  }
  if (request.requireUnattached && session.hasAttachedClients) {
    return { accepted: false, result: { outcome: 'refused', reason: 'attached' } }
  }
  try {
    // kill reserves the exact Session synchronously, before its first OS probe.
    const completion = deps
      .kill(request.id, { immediate: true })
      .then((): PtyFencedTerminationOutcome =>
        session.isAlive ? { outcome: 'refused', reason: 'unverifiable' } : { outcome: 'ended' }
      )
      .catch((): PtyFencedTerminationOutcome => ({ outcome: 'refused', reason: 'unverifiable' }))
    return { accepted: true, completion }
  } catch {
    return { accepted: false, result: { outcome: 'refused', reason: 'unverifiable' } }
  }
}
