import { mintAgentSessionOperationId } from '../structured-pointer-operation-id'
import {
  SESSION_LINK_MESSAGE_BYTES,
  SESSION_LINK_MESSAGE_LIMIT,
  SessionLinkEvent,
  type SessionLinkMessageKind
} from '../../../../shared/session-link'
import {
  sessionLinkWaitingFor,
  sessionLinkOwnerRequest
} from '../../../../shared/session-link-wait'
import type { SessionLinkStore } from './session-link-store'

export type SessionLinkAppend = {
  id: string
  linkId: string
  actor: string
  recipient: string
  body: string
  kind: SessionLinkMessageKind
  replyTo?: string
  requestId?: string
}

export function appendSessionLinkMessage(
  store: SessionLinkStore,
  input: SessionLinkAppend
): SessionLinkEvent {
  if (Buffer.byteLength(input.body, 'utf8') > SESSION_LINK_MESSAGE_BYTES) {
    throw new Error('Link messages are limited to 8 KiB. Reference a local report instead.')
  }
  return store.transaction(() => {
    const link = store.get(input.linkId)
    const existing = store.event(input.id)
    if (existing) {
      if (
        existing.linkId !== input.linkId ||
        existing.actor !== input.actor ||
        (existing.recipient !== input.recipient &&
          !(input.kind === 'owner-request' && existing.recipient === null)) ||
        existing.kind !== input.kind ||
        existing.replyTo !== (input.replyTo ?? null) ||
        existing.body !== input.body
      ) {
        throw new Error('Message operation was already used for different content.')
      }
      return { ...existing, body: input.body }
    }
    if (link.state === 'ended') {
      throw new Error('This session link has ended.')
    }
    const events = store.events(link.id)
    const agent = !['owner', 'host'].includes(input.actor)
    if (
      agent &&
      input.kind !== 'owner-request' &&
      events.filter((e) => ['queued', 'blocked', 'dispatching'].includes(e.state)).length >= 12
    ) {
      throw new Error('The link queue is full. Wait for delivery or ask the owner.')
    }
    if (agent && !link.participants.some((p) => p.sessionId === input.actor)) {
      throw new Error('Not a link participant.')
    }
    if (!link.participants.some((p) => p.sessionId === input.recipient)) {
      throw new Error('Not a link recipient.')
    }
    if (
      input.replyTo &&
      !events.some(
        (e) => e.id === input.replyTo && e.actor === input.recipient && e.recipient === input.actor
      )
    ) {
      throw new Error('Reply must name a message from this partner in this link.')
    }
    if (input.kind === 'reply' && !input.replyTo) {
      throw new Error('A reply must identify the partner message.')
    }
    if (
      agent &&
      (input.kind === 'checkpoint' || input.kind === 'question') &&
      sessionLinkWaitingFor(events, input.actor)
    ) {
      throw new Error('Your previous checkpoint still awaits a reply. Finish this turn and wait.')
    }
    if (input.kind === 'reply' && input.replyTo) {
      const replied = events.find((e) => e.id === input.replyTo)
      if (
        events.some((e) => e.kind === 'reply' && e.replyTo === input.replyTo) ||
        (replied &&
          ['question', 'checkpoint'].includes(replied.kind) &&
          events
            .slice(events.indexOf(replied) + 1)
            .some((e) => e.actor === replied.actor && ['question', 'checkpoint'].includes(e.kind)))
      ) {
        throw new Error('This checkpoint was already answered or superseded.')
      }
    }
    if (input.kind === 'owner-request' && sessionLinkOwnerRequest(events)) {
      throw new Error(
        'An owner decision is already pending. Finish this turn and wait for the owner.'
      )
    }
    if (
      agent &&
      input.kind !== 'owner-request' &&
      !link.policy &&
      link.messages >= SESSION_LINK_MESSAGE_LIMIT
    ) {
      throw new Error('Link message limit reached. Ask the owner to continue.')
    }
    if (agent) {
      link.messages++
    }
    const recent = events
      .slice(events.findLastIndex((e) => e.kind === 'control' && e.detail === 'resume') + 1)
      .filter((e) => e.actor === input.actor && e.messageId)
      .slice(-2)
    const pauseReason =
      input.kind === 'owner-request'
        ? 'owner-decision'
        : agent && recent.length === 2 && recent.every((e) => e.body === input.body)
          ? 'repeated-messages'
          : agent && !link.policy && link.messages >= SESSION_LINK_MESSAGE_LIMIT
            ? 'message-limit'
            : null
    const message =
      input.kind === 'owner-request'
        ? null
        : store.orchestration.insertMessage({
            from:
              input.actor === 'host'
                ? 'session-link'
                : input.actor === 'owner'
                  ? 'owner'
                  : `orca_session_id:${input.actor}`,
            to: `orca_session_id:${input.recipient}`,
            subject: link.story.slice(0, 160),
            body: input.body,
            threadId: link.id,
            // The link outbox owns delivery; generic mailbox nudges must never bypass its pause.
            deliveryContract: 'audit_only'
          })
    const event = SessionLinkEvent.parse({
      id: input.id,
      linkId: link.id,
      actor: input.actor,
      recipient: input.kind === 'owner-request' ? null : input.recipient,
      kind: input.kind,
      replyTo: input.replyTo ?? null,
      messageId: message?.id ?? null,
      state: message ? 'queued' : 'recorded',
      operationId: mintAgentSessionOperationId(Date.now()),
      createdAt: Date.now(),
      detail: '',
      body: input.body,
      ...(input.requestId ? { requestId: input.requestId } : {})
    })
    store.write(event)
    link.updatedAt = Date.now()
    store.save(link)
    if (pauseReason) {
      store.pause(link.id, pauseReason)
    }
    return event
  })
}
