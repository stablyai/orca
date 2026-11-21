import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import type { Session } from '../sessions/session'
import {
  IdlePtyTeardownRefusal,
  type PosixIdlePtyGuard
} from '../../pty/process-retirement/idle-pty-teardown-refusal'
import type { ClaimedAgentPtyOwnerRegistry } from '../../../shared/agent-session/lifecycle/leases/claimed-agent-pty-owner'

type FencedTermination =
  | { accepted: false; result: PtyFencedTerminationOutcome }
  | { accepted: true; completion: Promise<PtyFencedTerminationOutcome> }

export type FencedPosixIdleEvidence = {
  shellPids: ReadonlySet<number>
  onCommitting: () => void
}

export function beginTerminalHostFencedTermination(
  request: PtyFencedTerminationRequest,
  deps: {
    sessions: ReadonlyMap<string, Session>
    pendingCreations: ReadonlyMap<string, unknown>
    owners: ClaimedAgentPtyOwnerRegistry
    kill: (id: string, options: { immediate: true; idleGuard?: PosixIdlePtyGuard }) => Promise<void>
    idleEvidence?: FencedPosixIdleEvidence
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
  // Current mains check viewers themselves; this guards older mains and direct callers.
  if (request.requireUnattached && session.hasAttachedClients) {
    return { accepted: false, result: { outcome: 'refused', reason: 'attached' } }
  }
  const idleCheckSinceMs = request.idleCheckSinceMs ?? Date.now()
  if (request.requireIdle && session.getCommandActivity(idleCheckSinceMs) !== 'idle') {
    return { accepted: false, result: { outcome: 'refused', reason: 'running_work' } }
  }
  try {
    const { idleEvidence } = deps
    const idleGuard = idleEvidence && {
      shellPids: idleEvidence.shellPids,
      verifyIdle: () => {
        if (session.getCommandActivity(idleCheckSinceMs) !== 'idle') {
          throw new IdlePtyTeardownRefusal('running_work')
        }
        idleEvidence.onCommitting()
      }
    }
    // kill reserves the exact Session synchronously, before its first OS probe.
    const completion = deps
      .kill(request.id, idleGuard ? { immediate: true, idleGuard } : { immediate: true })
      .then((): PtyFencedTerminationOutcome =>
        session.isAlive ? { outcome: 'refused', reason: 'unverifiable' } : { outcome: 'ended' }
      )
      .catch((error: unknown): PtyFencedTerminationOutcome => ({
        outcome: 'refused',
        reason: error instanceof IdlePtyTeardownRefusal ? error.reason : 'unverifiable'
      }))
    return { accepted: true, completion }
  } catch {
    return { accepted: false, result: { outcome: 'refused', reason: 'unverifiable' } }
  }
}
