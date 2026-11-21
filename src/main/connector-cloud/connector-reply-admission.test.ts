import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { base, pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { ConnectorTurnEvents } from './connector-turn-events'

// Design item 125 §3 and §8 (received order, pre-commit crash): under the reply outbox a delivery is
// received only once its admission committed, with its done in the same request; one refused
// before the journal is done alone.

const h = pollClientHarness()
const start = (deliveryId: string) => ({
  ...base,
  deliveryId,
  kind: 'start',
  agent: 'claude',
  placeId: Buffer.from(JSON.stringify(['bot', 'b1'])).toString('base64url'),
  prompt: 'fix it'
})
const AckRequest = z.object({
  acks: z.array(z.object({ deliveryId: z.string(), step: z.string() }))
})
const ackRequests = () =>
  h.fake
    .requestsTo(CONNECTOR_PATHS.acks)
    .map((request) =>
      AckRequest.parse(request.body).acks.map((ack) => `${ack.deliveryId}:${ack.step}`)
    )

describe('received after admission', () => {
  it('acknowledges an admitted start as received and done in one request', async () => {
    h.fake.features = ['replies.outbox']
    const { client } = h.startClient()
    await settle()
    h.poll([start('d1')])
    await settle()
    expect(ackRequests()).toEqual([['d1:received', 'd1:done']])
    client.stop()
  })

  it('never acknowledges a start refused before the journal as received', async () => {
    h.fake.features = ['replies.outbox']
    const { client, outcomes } = h.startClient()
    outcomes.set('d1', Promise.resolve({ outcome: 'refused', reason: 'agent_not_reachable' }))
    await settle()
    h.poll([start('d1')])
    await settle()
    expect(ackRequests()).toEqual([['d1:done']])
    client.stop()
  })
})

describe('the capability a held poll ran under', () => {
  it('admits a delivery through the outbox when its poll began under a hello that listed it', async () => {
    h.fake.features = ['replies.outbox']
    const events = new ConnectorTurnEvents(h.userDataPath, 'ada')
    const { client, calls } = h.startClient(undefined, events)
    await settle()
    // A newer hello drops the feature while the poll is held.
    events.useCloudFeatures(new Set(), 2)
    h.poll([start('d1')])
    await settle()
    expect(calls.start).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'd1',
      expect.objectContaining({ reply: { account: 'ada' } })
    )
    client.stop()
  })
})

describe('a head and its carried sends', () => {
  const asker = {
    userId: 'U0DANA',
    role: 'owner',
    place: { kind: 'channel', id: 'C0FEED' },
    context: []
  }
  const withAsker = (delivery: Record<string, unknown>, text: string) => ({
    ...delivery,
    asker: { ...asker, text },
    askedAt: base.expiresAt - 400_000
  })

  it('holds received for the head and its carried ids until the admission commits', async () => {
    h.fake.features = ['replies.outbox']
    const { client, outcomes, calls } = h.startClient()
    let commit: () => void = () => {}
    outcomes.set('d1', new Promise((resolve) => (commit = () => resolve({ outcome: 'accepted' }))))
    await settle()
    h.poll([
      withAsker(start('d1'), 'fix it'),
      withAsker({ ...base, deliveryId: 'd2', kind: 'send', text: 'and the tests' }, 'and the tests')
    ])
    await settle()
    expect(calls.start).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'd1',
      expect.objectContaining({ reply: { account: 'ada', carried: ['d2'] } })
    )
    expect(ackRequests().flat()).toEqual([])
    commit()
    await settle()
    expect(ackRequests().flat().sort()).toEqual([
      'd1:done',
      'd1:received',
      'd2:done',
      'd2:received'
    ])
    client.stop()
  })

  it('sends received and done again after the first acknowledgement was lost', async () => {
    h.fake.features = ['replies.outbox']
    const { client } = h.startClient()
    await settle()
    h.fake.forced.set(CONNECTOR_PATHS.acks, { status: 503 })
    h.poll([start('d1')])
    await settle()
    h.fake.forced.delete(CONNECTOR_PATHS.acks)
    await settle(2_000)
    expect(h.fake.acks).toEqual(
      expect.arrayContaining([
        { deliveryId: 'd1', step: 'received' },
        { deliveryId: 'd1', step: 'done', result: { outcome: 'accepted' } }
      ])
    )
    client.stop()
  })
})

describe('legacy admission', () => {
  it('stamps nothing for the outbox under a hello that doesn’t list it', async () => {
    h.fake.features = []
    const { client, calls } = h.startClient()
    await settle()
    h.poll([start('d1')])
    await settle()
    expect(calls.start).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'd1',
      expect.not.objectContaining({ reply: expect.anything() })
    )
    expect(ackRequests()).toEqual([['d1:received'], ['d1:done']])
    client.stop()
  })
})
