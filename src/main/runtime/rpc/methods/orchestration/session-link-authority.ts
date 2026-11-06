import type { SessionLinkStore } from '../../../orchestration/session-links/session-link-store'
import type { SessionLinkControlTurn } from '../../../orchestration/session-links/session-link-stop'
import type { RpcContext } from '../../core'
import type { SessionLink } from '../../../../../shared/session-link'
import { OrchestrationError } from '../../../orchestration/orchestration-error'

export function isSessionLinkOwner(context: RpcContext): boolean {
  return context.caller?.kind === 'desktop'
}
export function requireSessionLinkOwner(context: RpcContext): void {
  if (!isSessionLinkOwner(context)) {
    throw new OrchestrationError(
      'owner_required',
      'Only the owner in Orca can create or resume a session link.',
      { effectsApplied: false }
    )
  }
}
export function sessionLinkActor(context: RpcContext, link: SessionLink): string {
  if (isSessionLinkOwner(context)) {
    return 'owner'
  }
  const caller = context.orchestrationCaller
  const participant = caller && link.participants.find((p) => p.sessionId === caller.sessionId)
  if (!participant) {
    throw new OrchestrationError(
      'participant_required',
      'This caller is not a participant in the session link.',
      { effectsApplied: false }
    )
  }
  return participant.sessionId
}

export function sessionLinkControlTurn(
  store: SessionLinkStore,
  link: SessionLink,
  actor: string,
  operationId: string | undefined
): SessionLinkControlTurn | undefined {
  if (actor === 'owner') {
    return undefined
  }
  if (
    !operationId ||
    !store
      .events(link.id)
      .some((event) => event.recipient === actor && event.operationId === operationId)
  ) {
    throw new OrchestrationError(
      'control_turn_required',
      'Use --turn-operation from the link message that issued this control. No effects were applied.',
      { effectsApplied: false }
    )
  }
  return { sessionId: actor, operationId }
}
