import { linkWrite, snapshot, verifyResumeParticipants } from './session-link-rpc-state'
import {
  isSessionLinkOwner,
  requireSessionLinkOwner,
  sessionLinkActor,
  sessionLinkControlTurn
} from './session-link-authority'
import { appendSessionLinkIntroductions } from '../../../orchestration/session-links/session-link-message'
import { resolveUnknownSessionLinkDelivery } from '../../../orchestration/session-links/session-link-resolution'
import {
  sessionLinkEventId as eventId,
  writeSessionLinkControl,
  writeSessionLinkPolicy
} from '../../../orchestration/session-links/session-link-owner-control'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import {
  LinkCreateParams,
  LinkAddParticipantsParams,
  LinkSetPolicyParams,
  LinkControlParams,
  LinkResolveParams,
  LinkSendParams,
  LinkListParams,
  LinkShowParams
} from '../../../../../shared/session-link'
import { SessionLinkStore } from '../../../orchestration/session-links/session-link-store'
import { sessionLinkCandidates } from '../../../orchestration/session-links/session-link-participants'
import { redriveSessionLinks } from '../../../orchestration/session-links/session-link-delivery'
import { stopSessionLinkTurns } from '../../../orchestration/session-links/session-link-stop'
import { canonicalOrcaSessionId } from '../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import {
  addSessionLinkParticipants,
  requireSessionLinkGroupSupport,
  sessionLinkNeedsGroupSupport,
  sessionLinkRecipients
} from '../../../orchestration/session-links/session-link-group'

export const SESSION_LINK_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.linkSetPolicy',
    access: { kind: 'writes', targets: { id: 'sessionLink' } },
    permission: 'workspace',
    params: LinkSetPolicyParams,
    handler: async (params, context) => {
      requireSessionLinkOwner(context)
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      linkWrite(() => requireSessionLinkGroupSupport(store.get(params.id), params.groupSupport))
      const replay = store.event(eventId(params.id, 'owner', params.operationId))
      if (params.resume && !replay) {
        await verifyResumeParticipants(store, params.id, context)
      }
      linkWrite(() => writeSessionLinkPolicy(store, params))
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id, params.groupSupport)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkCandidates',
    access: { kind: 'reads', targets: { sessionId: 'session' }, collection: true },
    permission: 'workspace',
    params: LinkListParams,
    handler: async ({ sessionId, groupSupport }, context) => {
      requireSessionLinkOwner(context)
      const participants = (await sessionLinkCandidates(context.runtime)).filter(
        (p) => groupSupport || ['claude', 'codex'].includes(p.agent)
      )
      const source = participants.find((p) => p.sessionId === sessionId)
      if (!source) {
        throw new OrchestrationError(
          'session_link_refused',
          'This chat is not available for session links on this host.',
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
          .filter(
            (link) =>
              (groupSupport || !sessionLinkNeedsGroupSupport(link)) &&
              link.participants.some((p) => p.conversationId === source.conversationId)
          )
          .slice(-20)
          .toReversed()
      }
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkAddParticipants',
    access: { kind: 'writes', targets: { id: 'sessionLink', sessionIds: 'session' } },
    permission: 'workspace',
    params: LinkAddParticipantsParams,
    handler: async (params, context) => {
      requireSessionLinkOwner(context)
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const replay = store.event(eventId(params.id, 'owner', params.operationId))
      const candidates = replay ? [] : await sessionLinkCandidates(context.runtime)
      linkWrite(() => addSessionLinkParticipants(store, params, candidates))
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id, true)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkCreate',
    access: {
      kind: 'writes',
      targets: {
        id: 'sessionLink',
        sessionId: 'session',
        partnerSessionId: 'session',
        partnerSessionIds: 'session'
      }
    },
    permission: 'workspace',
    params: LinkCreateParams,
    handler: async (params, context) => {
      requireSessionLinkOwner(context)
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const partnerIds =
        params.partnerSessionIds ?? (params.partnerSessionId ? [params.partnerSessionId] : [])
      const existing = store.list().find((link) => link.id === params.id)
      if (existing) {
        linkWrite(() => {
          if (
            existing.story !== params.story ||
            JSON.stringify(existing.policy) !== JSON.stringify(params.policy) ||
            JSON.stringify(
              existing.initialParticipantSessionIds ??
                existing.participants.slice(0, 2).map((p) => p.sessionId)
            ) !== JSON.stringify([params.sessionId, ...partnerIds]) ||
            existing.participants[0].role !== params.role
          ) {
            throw new OrchestrationError(
              'session_link_refused',
              'This operation already created a different session link.',
              { effectsApplied: false }
            )
          }
        })
        return snapshot(context, params.id, params.groupSupport)
      }
      const candidates = await sessionLinkCandidates(context.runtime)
      const source = candidates.find((p) => p.sessionId === params.sessionId)
      const partners = partnerIds.map((id) => candidates.find((p) => p.sessionId === id))
      if (!source || partners.some((p) => !p)) {
        throw new OrchestrationError(
          'session_link_refused',
          'Choose different available chats on this host.',
          { effectsApplied: false }
        )
      }
      source.role = params.role
      const participants = [
        source,
        ...partners
          .filter((p) => p !== undefined)
          .map((p) => ({
            ...p,
            role: params.role === 'reviewer' ? ('implementer' as const) : ('reviewer' as const)
          }))
      ]
      linkWrite(() =>
        store.transaction(() => {
          requireSessionLinkGroupSupport({ participants }, params.groupSupport)
          const link = store.create(params.id, params.story, participants, params.policy)
          appendSessionLinkIntroductions(store, link, 'introduction')
        })
      )
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id, params.groupSupport)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkCurrent',
    access: { kind: 'reads', targets: { sessionId: 'session' } },
    permission: 'workspace',
    params: LinkListParams,
    handler: ({ sessionId, groupSupport }, context) => {
      const root = canonicalOrcaSessionId(sessionId)
      if (!isSessionLinkOwner(context) && context.orchestrationCaller?.orcaSessionId !== root) {
        throw new OrchestrationError('session_link_refused', 'Read only your own session link.', {
          effectsApplied: false
        })
      }
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const link = store.forSession(root)
      return link ? snapshot(context, link.id, groupSupport) : null
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkShow',
    access: { kind: 'reads', targets: { id: 'sessionLink' } },
    permission: 'workspace',
    params: LinkShowParams,
    handler: ({ id, groupSupport }, context) => snapshot(context, id, groupSupport)
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkSend',
    access: { kind: 'writes', targets: { id: 'sessionLink', to: 'session' } },
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
      linkWrite(() => requireSessionLinkGroupSupport(link, params.groupSupport))
      const recipients = linkWrite(() => sessionLinkRecipients(store, link, from, params))
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
              ...(params.choices ? { choices: params.choices } : {}),
              ...(params.allowOther !== undefined ? { allowOther: params.allowOther } : {}),
              ...(params.replyTo ? { replyTo: params.replyTo } : {})
            })
          }
        })
      )
      void redriveSessionLinks(store.orchestration).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id, params.groupSupport)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkResolve',
    access: { kind: 'writes', targets: { id: 'sessionLink' } },
    permission: 'workspace',
    params: LinkResolveParams,
    handler: (params, context) => {
      requireSessionLinkOwner(context)
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      linkWrite(() => requireSessionLinkGroupSupport(store.get(params.id), params.groupSupport))
      linkWrite(() => resolveUnknownSessionLinkDelivery(store, params))
      return snapshot(context, params.id, params.groupSupport)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkControl',
    access: { kind: 'writes', targets: { id: 'sessionLink' } },
    permission: 'workspace',
    params: LinkControlParams,
    handler: async (params, context) => {
      const store = new SessionLinkStore(context.runtime.getOrchestrationDb())
      const link = store.get(params.id)
      const from = sessionLinkActor(context, link)
      if (from !== 'owner' && params.action !== 'end' && params.action !== 'stop') {
        requireSessionLinkOwner(context)
      }
      linkWrite(() => requireSessionLinkGroupSupport(link, params.groupSupport))
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
      return snapshot(context, params.id, params.groupSupport)
    }
  })
]
