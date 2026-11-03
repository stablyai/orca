import { createHash } from 'node:crypto'
import type { SessionLinkDeliveryResolution } from '../../../../shared/session-link'
import type { SessionLinkStore } from './session-link-store'

export function resolveUnknownSessionLinkDelivery(
  store: SessionLinkStore,
  input: SessionLinkDeliveryResolution
): void {
  store.transaction(() => {
    const id = createHash('sha256')
      .update(JSON.stringify([input.id, 'owner-resolution', input.operationId]))
      .digest('hex')
    const replay = store.event(id)
    if (replay) {
      if (replay.linkId !== input.id || replay.replyTo !== input.eventId) {
        throw new Error('This review operation belongs to another delivery.')
      }
      return
    }
    const link = store.get(input.id)
    const event = store.event(input.eventId)
    if (link.version !== input.version || link.state !== 'paused') {
      throw new Error('The link changed. Refresh before reviewing delivery.')
    }
    if (
      !event ||
      event.linkId !== link.id ||
      event.state !== 'blocked' ||
      event.retryable !== false ||
      !event.messageId ||
      !event.operationId
    ) {
      throw new Error('Only an unconfirmed delivery can be marked reviewed.')
    }
    store.write({ ...event, state: 'cancelled', detail: 'delivery-reviewed' })
    store.write({
      id,
      linkId: link.id,
      actor: 'owner',
      recipient: event.recipient,
      kind: 'control',
      messageId: null,
      replyTo: event.id,
      state: 'recorded',
      operationId: '',
      requestId: input.operationId,
      createdAt: Date.now(),
      body: '',
      detail: 'delivery-reviewed'
    })
    link.version++
    link.updatedAt = Date.now()
    if (!store.events(link.id).some((e) => e.state === 'blocked' && e.retryable === false)) {
      link.reason = 'delivery-reviewed'
    }
    store.save(link)
  })
}
