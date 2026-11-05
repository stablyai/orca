import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { LinkControlParams, LinkSetPolicyParams } from '../../../../shared/session-link'
import { sessionLinkOwnerRequest } from '../../../../shared/session-link-wait'
import type { SessionLinkStore } from './session-link-store'

export function sessionLinkEventId(...values: string[]): string {
  return createHash('sha256').update(JSON.stringify(values)).digest('hex')
}

export function requireSessionLinkResume(
  store: SessionLinkStore,
  id: string,
  answer?: string
): void {
  const events = store.events(id)
  if (events.some((event) => event.state === 'blocked' && event.retryable === false)) {
    throw new Error('Review the unconfirmed delivery before resuming.')
  }
  if (!answer && sessionLinkOwnerRequest(events)) {
    throw new Error('Answer the owner decision before resuming the link.')
  }
}

export function writeSessionLinkControl(
  store: SessionLinkStore,
  actor: string,
  params: z.infer<typeof LinkControlParams>
): void {
  store.transaction(() => {
    const id = sessionLinkEventId(params.id, actor, params.operationId)
    const replay = store.event(id)
    const link = store.get(params.id)
    const notes = link.participants.map((p) => ({
      id: sessionLinkEventId(params.id, actor, params.operationId, 'answer', p.sessionId),
      recipient: p.sessionId
    }))
    if (replay) {
      if (notes.some((note) => store.event(note.id)?.body !== params.ownerMessage)) {
        throw new Error('Operation belongs to another owner answer.')
      }
    } else {
      if (link.version !== params.version) {
        throw new Error('The link changed. Refresh before acting.')
      }
      if (params.action === 'resume') {
        requireSessionLinkResume(store, params.id, params.ownerMessage)
      }
      if (params.ownerMessage) {
        if (actor !== 'owner') {
          throw new Error('Only the owner can answer an owner decision.')
        }
        for (const note of notes) {
          store.append({
            ...note,
            linkId: params.id,
            actor: 'owner',
            kind: 'owner-note',
            body: params.ownerMessage,
            requestId: params.operationId
          })
        }
      }
      if (params.action === 'resume') {
        // Legacy owner questions were queued to the partner; retain them without asking again.
        for (const event of store.events(params.id)) {
          if (event.kind === 'owner-request' && ['queued', 'blocked'].includes(event.state)) {
            store.write({ ...event, state: 'recorded', detail: 'owner-answered' })
          }
        }
      }
    }
    store.control(
      params.id,
      actor,
      id,
      params.version,
      params.action,
      params.operationId,
      params.summary
    )
  })
}

export function writeSessionLinkPolicy(
  store: SessionLinkStore,
  params: z.infer<typeof LinkSetPolicyParams>
): void {
  store.transaction(() => {
    const id = sessionLinkEventId(params.id, 'owner', params.operationId)
    const previous = store.event(id)
    const detail = params.resume ? 'policy-resume' : 'policy'
    if (previous) {
      if (
        previous.actor !== 'owner' ||
        previous.detail !== detail ||
        previous.policy?.turnLimit !== params.policy.turnLimit
      ) {
        throw new Error('Operation belongs to another link policy.')
      }
      return
    }
    const link = store.get(params.id)
    if (link.version !== params.version || link.state === 'ended') {
      throw new Error('The link changed. Refresh before acting.')
    }
    if (params.resume) {
      requireSessionLinkResume(store, link.id)
      if (link.state !== 'paused' || !['turn-limit', 'message-limit'].includes(link.reason)) {
        throw new Error('Changing the limit can only resume a limit pause.')
      }
    }
    store.save({ ...link, policy: params.policy, version: link.version + 1, updatedAt: Date.now() })
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
      policy: params.policy,
      createdAt: Date.now(),
      detail,
      body: ''
    })
    if (params.resume) {
      store.control(link.id, 'owner', sessionLinkEventId(id, 'resume'), link.version + 1, 'resume')
    }
  })
}
