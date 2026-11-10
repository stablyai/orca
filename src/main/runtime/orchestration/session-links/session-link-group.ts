import type { z } from 'zod'
import type {
  LinkAddParticipantsParams,
  LinkSendParams,
  SessionLink,
  SessionLinkParticipant
} from '../../../../shared/session-link'
import { sessionLinkPeers } from '../../../../shared/session-link'
import { sessionLinkEventId } from './session-link-owner-control'
import { appendSessionLinkIntroductions } from './session-link-message'
import type { SessionLinkStore } from './session-link-store'

export function sessionLinkNeedsGroupSupport(link: Pick<SessionLink, 'participants'>): boolean {
  return (
    link.participants.length > 2 ||
    link.participants.some((p) => !['claude', 'codex'].includes(p.agent))
  )
}

export function requireSessionLinkGroupSupport(
  link: Pick<SessionLink, 'participants'>,
  supported?: true
): void {
  if (sessionLinkNeedsGroupSupport(link) && !supported) {
    throw new Error('Update this Orca client or CLI to use this group link.')
  }
}

export function sessionLinkRecipients(
  store: SessionLinkStore,
  link: SessionLink,
  actor: string,
  params: z.infer<typeof LinkSendParams>
): SessionLinkParticipant[] {
  const previous = store
    .events(link.id)
    .filter((e) => e.actor === actor && e.requestId === params.operationId)
  const reply = params.replyTo ? store.event(params.replyTo) : null
  const peers = actor === 'owner' ? link.participants : sessionLinkPeers(link, actor)
  if ((actor === 'owner' || params.kind === 'owner-request') && params.to) {
    throw new Error('Owner messages do not take a peer recipient.')
  }
  const target =
    params.to ?? (reply?.linkId === link.id && reply.recipient === actor ? reply.actor : undefined)
  if (previous.length) {
    if (target && previous.some((e) => e.recipient !== target)) {
      throw new Error('Message operation was already used for another recipient.')
    }
    return peers
      .filter((p) =>
        previous.some(
          (e) => e.recipient === p.sessionId || (e.kind === 'owner-request' && e.recipient === null)
        )
      )
      .slice(0, params.kind === 'owner-request' ? 1 : undefined)
  }
  if (actor === 'owner') {
    return peers
  }
  if (params.kind === 'owner-request') {
    return peers.slice(0, 1)
  }
  const recipient = target
    ? peers.find((p) => p.sessionId === target)
    : peers.length === 1
      ? peers[0]
      : undefined
  if (!recipient) {
    throw new Error(
      `Choose a participant with --to <session_id>: ${peers.map((p) => `${p.name} (${p.sessionId})`).join(', ')}`
    )
  }
  return [recipient]
}

export function addSessionLinkParticipants(
  store: SessionLinkStore,
  params: z.infer<typeof LinkAddParticipantsParams>,
  candidates: SessionLinkParticipant[]
): SessionLink {
  return store.transaction(() => {
    const id = sessionLinkEventId(params.id, 'owner', params.operationId)
    const previous = store.event(id)
    const link = store.get(params.id)
    if (previous) {
      if (
        previous.actor !== 'owner' ||
        previous.detail !== 'participants-added' ||
        JSON.stringify(previous.participantSessionIds) !== JSON.stringify(params.sessionIds)
      ) {
        throw new Error('Operation belongs to another link membership change.')
      }
      return link
    }
    if (link.version !== params.version || link.state === 'ended') {
      throw new Error('The link changed. Refresh before adding participants.')
    }
    const added = params.sessionIds.map((sessionId) => {
      const candidate = candidates.find((p) => p.sessionId === sessionId)
      if (!candidate) {
        throw new Error('A selected chat is no longer available. Refresh the participant list.')
      }
      if (store.forSession(candidate.conversationId)) {
        throw new Error('A participant already has an active session link.')
      }
      return candidate
    })
    const next = {
      ...link,
      participants: [...link.participants, ...added],
      version: link.version + 1,
      updatedAt: Date.now()
    }
    store.save(next)
    for (const p of added) {
      store.orchestration.db
        .prepare('INSERT INTO session_link_participants (session_id, link_id) VALUES (?, ?)')
        .run(p.conversationId, link.id)
    }
    store.write({
      id,
      linkId: link.id,
      actor: 'owner',
      recipient: null,
      kind: 'control',
      messageId: null,
      replyTo: null,
      state: 'recorded',
      operationId: '',
      requestId: params.operationId,
      createdAt: Date.now(),
      detail: 'participants-added',
      body: '',
      participantSessionIds: params.sessionIds
    })
    appendSessionLinkIntroductions(
      store,
      next,
      id,
      'The owner added participants. The existing story and journal are unchanged.\n\n'
    )
    return next
  })
}
