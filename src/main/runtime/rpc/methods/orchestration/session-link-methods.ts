import {
  isSessionLinkOwner,
  requireSessionLinkOwner,
  sessionLinkActor,
  sessionLinkControlTurn
} from './session-link-authority'
import { sessionLinkIntroduction } from '../../../orchestration/session-links/session-link-message'
import { resolveUnknownSessionLinkDelivery } from '../../../orchestration/session-links/session-link-resolution'
import {
  sessionLinkEventId as eventId,
  writeSessionLinkControl,
  writeSessionLinkPolicy
} from '../../../orchestration/session-links/session-link-owner-control'
import { defineMethod, type RpcContext } from '../../core'
import {
  LinkCreateParams,
  LinkSetPolicyParams,
  LinkControlParams,
  LinkResolveParams,
  LinkSendParams,
  LinkListParams,
  LinkShowParams,
  sessionLinkPartner
} from '../../../../../shared/session-link'
import { SessionLinkStore } from '../../../orchestration/session-links/session-link-store'
import { sessionLinkCandidates } from '../../../orchestration/session-links/session-link-participants'
import { redriveSessionLinks } from '../../../orchestration/session-links/session-link-delivery'
import { stopSessionLinkTurns } from '../../../orchestration/session-links/session-link-stop'
import { canonicalOrcaSessionId } from '../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { OrchestrationError } from '../../../orchestration/orchestration-error'

function linkWrite<T>(action: () => T): T {
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
function snapshot(context: RpcContext, id: string) {
  const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
  const link = store.get(id)
  sessionLinkActor(context, link)
  return { link, events: store.events(id) }
}

async function verifyResumeParticipants(
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

export const SESSION_LINK_METHODS = [
  defineMethod({
    name: 'orchestration.linkSetPolicy',
    permission: 'workspace',
    params: LinkSetPolicyParams,
    handler: async (params, context) => {
      requireSessionLinkOwner(context)
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const replay = store.event(eventId(params.id, 'owner', params.operationId))
      if (params.resume && !replay) {
        await verifyResumeParticipants(store, params.id, context)
      }
      linkWrite(() => writeSessionLinkPolicy(store, params))
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id)
    }
  }),
  defineMethod({
    name: 'orchestration.linkCandidates',
    permission: 'workspace',
    params: LinkListParams,
    handler: async ({ sessionId }, context) => {
      requireSessionLinkOwner(context)
      const participants = await sessionLinkCandidates(context.runtime)
      const source = participants.find((p) => p.sessionId === sessionId)
      if (!source) {
        throw new OrchestrationError(
          'session_link_refused',
          'This chat is not an available local Claude or Codex session.',
          { effectsApplied: false }
        )
      }
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      return {
        source,
        candidates: participants.filter(
          (p) => p.conversationId !== source.conversationId && !store.forSession(p.conversationId)
        ),
        history: store
          .list()
          .filter((link) =>
            link.participants.some((p) => p.conversationId === source.conversationId)
          )
          .slice(-20)
          .toReversed()
      }
    }
  }),
  defineMethod({
    name: 'orchestration.linkCreate',
    permission: 'workspace',
    params: LinkCreateParams,
    handler: async (params, context) => {
      requireSessionLinkOwner(context)
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const existing = store.list().find((link) => link.id === params.id)
      if (existing) {
        linkWrite(() => {
          if (
            existing.story !== params.story ||
            JSON.stringify(existing.policy) !== JSON.stringify(params.policy) ||
            existing.participants[0].sessionId !== params.sessionId ||
            existing.participants[1].sessionId !== params.partnerSessionId ||
            existing.participants[0].role !== params.role
          ) {
            throw new OrchestrationError(
              'session_link_refused',
              'This operation already created a different session link.',
              { effectsApplied: false }
            )
          }
        })
        return snapshot(context, params.id)
      }
      const candidates = await sessionLinkCandidates(context.runtime)
      const source = candidates.find((p) => p.sessionId === params.sessionId)
      const partner = candidates.find((p) => p.sessionId === params.partnerSessionId)
      if (!source || !partner || source.conversationId === partner.conversationId) {
        throw new OrchestrationError(
          'session_link_refused',
          'Choose two different available local chats.',
          { effectsApplied: false }
        )
      }
      source.role = params.role
      partner.role = params.role === 'reviewer' ? 'implementer' : 'reviewer'
      linkWrite(() =>
        store.transaction(() => {
          const link = store.create(params.id, params.story, [source, partner], params.policy)
          for (const recipient of link.participants) {
            store.append({
              id: eventId(link.id, 'introduction', recipient.sessionId),
              linkId: link.id,
              actor: 'host',
              recipient: recipient.sessionId,
              kind: 'introduction',
              body: sessionLinkIntroduction(link, recipient)
            })
          }
        })
      )
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id)
    }
  }),
  defineMethod({
    name: 'orchestration.linkCurrent',
    permission: 'workspace',
    params: LinkListParams,
    handler: ({ sessionId }, context) => {
      const root = canonicalOrcaSessionId(sessionId)
      if (!isSessionLinkOwner(context) && context.orchestrationCaller?.orcaSessionId !== root) {
        throw new OrchestrationError('session_link_refused', 'Read only your own session link.', {
          effectsApplied: false
        })
      }
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const link = store.forSession(root)
      return link ? snapshot(context, link.id) : null
    }
  }),
  defineMethod({
    name: 'orchestration.linkShow',
    permission: 'workspace',
    params: LinkShowParams,
    handler: ({ id }, context) => snapshot(context, id)
  }),
  defineMethod({
    name: 'orchestration.linkSend',
    permission: 'workspace',
    params: LinkSendParams,
    handler: (params, context) => {
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const link = store.get(params.id)
      const from = sessionLinkActor(context, link)
      if ((from === 'owner') !== (params.kind === 'owner-note')) {
        throw new OrchestrationError(
          'session_link_refused',
          'Only the owner can send owner notes; agents must retain agent provenance.',
          { effectsApplied: false }
        )
      }
      const recipients = from === 'owner' ? link.participants : [sessionLinkPartner(link, from)]
      linkWrite(() =>
        store.transaction(() => {
          for (const recipient of recipients) {
            store.append({
              id: eventId(link.id, from, params.operationId, recipient.sessionId),
              linkId: link.id,
              actor: from,
              recipient: recipient.sessionId,
              body: params.body,
              kind: params.kind,
              requestId: params.operationId,
              ...(params.replyTo ? { replyTo: params.replyTo } : {})
            })
          }
        })
      )
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id)
    }
  }),
  defineMethod({
    name: 'orchestration.linkResolve',
    permission: 'workspace',
    params: LinkResolveParams,
    handler: (params, context) => {
      requireSessionLinkOwner(context)
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      linkWrite(() => resolveUnknownSessionLinkDelivery(store, params))
      return snapshot(context, params.id)
    }
  }),
  defineMethod({
    name: 'orchestration.linkControl',
    permission: 'workspace',
    params: LinkControlParams,
    handler: async (params, context) => {
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const link = store.get(params.id)
      const from = sessionLinkActor(context, link)
      if (from !== 'owner' && params.action !== 'end' && params.action !== 'stop') {
        requireSessionLinkOwner(context)
      }
      const callingTurn = sessionLinkControlTurn(store, link, from, params.callerOperationId)
      const replay = store.event(eventId(link.id, from, params.operationId))
      if (params.action === 'resume' && !replay) {
        await verifyResumeParticipants(store, link.id, context)
      }
      linkWrite(() => writeSessionLinkControl(store, from, params))
      if (params.action === 'stop' || params.action === 'end') {
        await stopSessionLinkTurns(store, link.id, params.operationId, callingTurn)
      }
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id)
    }
  })
]
