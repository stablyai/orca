import {
  isSessionLinkOwner,
  requireSessionLinkOwner,
  sessionLinkActor
} from './session-link-authority'
import { sessionLinkIntroduction } from '../../../orchestration/session-links/session-link-message'
import { resolveUnknownSessionLinkDelivery } from '../../../orchestration/session-links/session-link-resolution'
import { createHash } from 'node:crypto'
import { defineMethod, type RpcContext } from '../../core'
import {
  LinkCreateParams,
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
import { canonicalOrcaSessionId } from '../../../orchestration/canonical-orca-session-id'
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
function eventId(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}
function snapshot(context: RpcContext, id: string) {
  const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
  const link = store.get(id)
  sessionLinkActor(context, link)
  return { link, events: store.events(id) }
}

export const SESSION_LINK_METHODS = [
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
          const link = store.create(params.id, params.story, [source, partner])
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
      const replay = store.event(eventId(link.id, from, params.operationId))
      if (params.action === 'resume' && !replay) {
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
      if (!replay && params.action === 'resume') {
        const events = store.events(link.id)
        if (events.some((event) => event.state === 'blocked' && event.retryable === false)) {
          throw new OrchestrationError(
            'session_link_refused',
            'Review the unconfirmed delivery before resuming.',
            { effectsApplied: false }
          )
        }
        const requestIndex = events.findLastIndex((e) => e.kind === 'owner-request')
        if (
          requestIndex !== -1 &&
          !events
            .slice(requestIndex + 1)
            .some((e) => e.actor === 'owner' && e.kind === 'owner-note')
        ) {
          throw new OrchestrationError(
            'session_link_refused',
            'Answer the owner decision before resuming the link.',
            { effectsApplied: false }
          )
        }
      }
      linkWrite(() =>
        store.control(
          link.id,
          from,
          eventId(link.id, from, params.operationId),
          params.version,
          params.action,
          params.operationId
        )
      )
      if (params.action === 'stop' || params.action === 'end') {
        await stopSessionLinkTurns(
          store,
          link.id,
          params.operationId,
          from !== 'owner' ? from : undefined
        )
      }
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id)
    }
  })
]
