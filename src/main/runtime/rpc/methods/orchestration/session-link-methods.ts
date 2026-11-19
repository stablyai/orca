import { linkWrite, snapshot, verifyResumeParticipants } from './session-link-rpc-state'
import {
  isSessionLinkOwner,
  requireSessionLinkOwner,
  sessionLinkActor,
  sessionLinkControlTurn
} from './session-link-authority'
import { sessionLinkEventId as eventId } from '../../../orchestration/session-links/session-link-owner-control'
import { localOrchestrationCliCommand } from '../../../orchestration/workers/launch/orchestration-cli-command'
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
import { sessionLinks } from '../../../orchestration/session-links/worker/session-link-worker-client'
import { sessionLinkCandidates } from '../../../orchestration/session-links/session-link-participants'
import { redriveSessionLinks } from '../../../orchestration/session-links/session-link-delivery'
import { stopSessionLinkTurns } from '../../../orchestration/session-links/session-link-stop'
import { canonicalOrcaSessionId } from '../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import {
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
      const db = context.runtime.getOrchestrationDb()
      const links = sessionLinks(db)
      await linkWrite(async () =>
        requireSessionLinkGroupSupport(await links.get(params.id), params.groupSupport)
      )
      const replay = await links.event(eventId(params.id, 'owner', params.operationId))
      if (params.resume && !replay) {
        await verifyResumeParticipants(links, params.id, context)
      }
      await linkWrite(() => links.setPolicy(params))
      void redriveSessionLinks(db).catch((error) =>
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
      const links = sessionLinks(context.runtime.getOrchestrationDb())
      const free = await Promise.all(
        participants.map(
          async (p) =>
            p.conversationId !== source.conversationId &&
            !(await links.forSession(p.conversationId))
        )
      )
      return {
        source,
        candidates: participants.filter((_, index) => free[index]),
        history: (await links.list())
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
      const db = context.runtime.getOrchestrationDb()
      const links = sessionLinks(db)
      const replay = await links.event(eventId(params.id, 'owner', params.operationId))
      const candidates = replay ? [] : await sessionLinkCandidates(context.runtime)
      await linkWrite(() =>
        links.addParticipants(params, candidates, localOrchestrationCliCommand())
      )
      void redriveSessionLinks(db).catch((error) =>
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
      const db = context.runtime.getOrchestrationDb()
      const links = sessionLinks(db)
      const partnerIds =
        params.partnerSessionIds ?? (params.partnerSessionId ? [params.partnerSessionId] : [])
      const existing = (await links.list()).find((link) => link.id === params.id)
      if (existing) {
        await linkWrite(() => {
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
      await linkWrite(() => {
        requireSessionLinkGroupSupport({ participants }, params.groupSupport)
        return links.create({
          id: params.id,
          story: params.story,
          participants,
          policy: params.policy,
          cli: localOrchestrationCliCommand()
        })
      })
      void redriveSessionLinks(db).catch((error) =>
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
    handler: async ({ sessionId, groupSupport }, context) => {
      const root = canonicalOrcaSessionId(sessionId)
      if (!isSessionLinkOwner(context) && context.orchestrationCaller?.orcaSessionId !== root) {
        throw new OrchestrationError('session_link_refused', 'Read only your own session link.', {
          effectsApplied: false
        })
      }
      const link = await sessionLinks(context.runtime.getOrchestrationDb()).forSession(root)
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
    handler: async (params, context) => {
      const db = context.runtime.getOrchestrationDb()
      const links = sessionLinks(db)
      const link = await links.get(params.id)
      const from = sessionLinkActor(context, link)
      if ((from === 'owner') !== (params.kind === 'owner-note')) {
        throw new OrchestrationError(
          'session_link_refused',
          'Only the owner can send owner notes; agents must retain agent provenance.',
          { effectsApplied: false }
        )
      }
      await linkWrite(() => requireSessionLinkGroupSupport(link, params.groupSupport))
      const recipients = await linkWrite(() => sessionLinkRecipients(links, link, from, params))
      await linkWrite(() =>
        links.send(
          recipients.map((recipient) => ({
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
          }))
        )
      )
      void redriveSessionLinks(db).catch((error) =>
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
    handler: async (params, context) => {
      requireSessionLinkOwner(context)
      const links = sessionLinks(context.runtime.getOrchestrationDb())
      await linkWrite(async () =>
        requireSessionLinkGroupSupport(await links.get(params.id), params.groupSupport)
      )
      await linkWrite(() => links.resolve(params))
      return snapshot(context, params.id, params.groupSupport)
    }
  }),
  defineOrchestrationMethod({
    name: 'orchestration.linkControl',
    access: { kind: 'writes', targets: { id: 'sessionLink' } },
    permission: 'workspace',
    params: LinkControlParams,
    handler: async (params, context) => {
      const db = context.runtime.getOrchestrationDb()
      const links = sessionLinks(db)
      const link = await links.get(params.id)
      const from = sessionLinkActor(context, link)
      if (from !== 'owner' && params.action !== 'end' && params.action !== 'stop') {
        requireSessionLinkOwner(context)
      }
      await linkWrite(() => requireSessionLinkGroupSupport(link, params.groupSupport))
      const callingTurn = await sessionLinkControlTurn(links, link, from, params.callerOperationId)
      const replay = await links.event(eventId(link.id, from, params.operationId))
      if (params.action === 'resume' && !replay) {
        await verifyResumeParticipants(links, link.id, context)
      }
      await linkWrite(() => links.control(from, params))
      if (params.action === 'stop' || params.action === 'end') {
        await stopSessionLinkTurns(links, link.id, params.operationId, callingTurn)
      }
      void redriveSessionLinks(db).catch((error) =>
        console.warn('[session-link] redrive unavailable', error)
      )
      return snapshot(context, params.id, params.groupSupport)
    }
  })
]
