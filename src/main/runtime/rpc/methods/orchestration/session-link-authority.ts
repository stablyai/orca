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
