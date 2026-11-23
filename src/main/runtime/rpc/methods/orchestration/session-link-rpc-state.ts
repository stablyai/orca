import type { RpcContext } from '../../core'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { sessionLinks } from '../../../orchestration/session-links/worker/session-link-worker-client'
import type { SessionLinks } from '../../../orchestration/session-links/worker/session-link-worker-protocol'
import { sessionLinkCandidates } from '../../../orchestration/session-links/session-link-participants'
import { requireSessionLinkGroupSupport } from '../../../orchestration/session-links/session-link-group'
import { sessionLinkActor } from './session-link-authority'

/** A refusal applied nothing; an unreachable worker keeps its own error, which says it may have. */
export async function linkWrite<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'session_link_unavailable') {
      throw error
    }
    throw new OrchestrationError(
      'session_link_refused',
      error instanceof Error ? error.message : String(error),
      { effectsApplied: false }
    )
  }
}
export async function snapshot(context: RpcContext, id: string, groupSupport?: true) {
  const links = sessionLinks(context.runtime.getOrchestrationDb())
  const link = await links.get(id)
  sessionLinkActor(context, link)
  await linkWrite(() => requireSessionLinkGroupSupport(link, groupSupport))
  return { link, events: await links.events(id) }
}

export async function verifyResumeParticipants(
  links: SessionLinks,
  id: string,
  context: RpcContext
): Promise<void> {
  const link = await links.get(id)
  const candidates = await sessionLinkCandidates(context.runtime)
  await linkWrite(() => {
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
