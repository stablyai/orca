import { expect, it, vi } from 'vitest'
import { CONNECTOR_AUDIENCE_EVENTS_VERSION } from '../../shared/connectors/connector-cloud-contract'
import { ConnectorEventRequests } from './connector-event-requests'
import type { ConnectorTurnEvents } from './connector-turn-events'

// Design item 125 §8 (scope / binding): a refused batch that carries replies is split down by the
// sender, never taken for an audience rejection that resets the hello and keeps it.

it('leaves a refused batch with a reply to the sender’s split rather than resetting the hello', async () => {
  const resetLive = vi.fn()
  const rejected = vi.fn(() => Promise.resolve(null))
  const requests = new ConnectorEventRequests({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: post reads only these members.
    events: {
      requestVersion: () => CONNECTOR_AUDIENCE_EVENTS_VERSION,
      resetLive
    } as unknown as ConnectorTurnEvents,
    watch: () => () => {},
    observe: () => {},
    flush: () => {},
    post: async () => ({ ok: false, status: 400, error: 'invalid_request', retryAfterMs: null }),
    rejected
  })
  const reply = {
    kind: 'reply' as const,
    conversation: { source: 'slack' as const, externalId: 'T1:C1:1.2' },
    deliveryIds: ['d1'],
    answerDeliveryId: 'd1',
    outcome: 'answered' as const,
    prose: 'Done.'
  }
  const failure = await requests.post([reply], 1, 0)
  expect(failure?.status).toBe(400)
  expect(rejected).not.toHaveBeenCalled()
  expect(resetLive).not.toHaveBeenCalled()
})
