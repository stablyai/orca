import type { RpcContext } from '../../core'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { SessionLinkStore } from '../../../orchestration/session-links/session-link-store'
import { sessionLinkCandidates } from '../../../orchestration/session-links/session-link-participants'
import { requireSessionLinkGroupSupport } from '../../../orchestration/session-links/session-link-group'
import { sessionLinkActor } from './session-link-authority'

export function linkWrite<T>(action: () => T): T {
  try {
    return action()
  } catch (error) {
    throw new OrchestrationError(
      'session_link_refused',
      error instanceof Error ? error.message : String(error),
      { effectsApplied: false }
    )
  }
}
export function snapshot(context: RpcContext, id: string, groupSupport?: true) {
  const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
  const link = store.get(id)
  sessionLinkActor(context, link)
  linkWrite(() => requireSessionLinkGroupSupport(link, groupSupport))
  return { link, events: store.events(id) }
}

export async function verifyResumeParticipants(
  store: SessionLinkStore,
  id: string,
  context: RpcContext
): Promise<void> {
  const link = store.get(id)
  const candidates = await sessionLinkCandidates(context.runtime)
  linkWrite(() => {
    if (
      !link.participants.every((participant) =>
        candidates.some(
          (candidate) =>
            candidate.sessionId === participant.sessionId &&
            candidate.context === participant.context &&
            candidate.workspaceId === participant.workspaceId
        )
      )
    ) {
      throw new OrchestrationError(
        'session_link_refused',
        'A participant closed or changed context. End this link and select the intended chats again.',
        { effectsApplied: false }
      )
    }
  })
}
