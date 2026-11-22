import { describe, expect, it } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { base, pollClientHarness, settle } from './connector-poll-client.test-fixture'

const h = pollClientHarness()
const OFFER = { wakeUrl: 'wss://wake.test/v1/connector/wake', safetyPollMs: 180_000 }

const polls = () => h.fake.requestsTo(CONNECTOR_PATHS.poll).map((request) => request.body)

/** A client whose socket is open and whose catch-up poll was answered. */
async function onWake() {
  h.fake.wakeOffer = OFFER
  h.fake.mintsWakeTokens = true
  const started = h.startClient()
  await settle()
  h.wake.last?.accept()
  h.poll([])
  await settle()
  expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1, holdMs: 0 })
  h.poll([])
  await settle()
  return started
}

describe('connector wake client', () => {
  it('without an offer polls exactly as before and opens no socket', async () => {
    h.fake.mintsWakeTokens = true
    const { client } = h.startClient()
    await settle()
    h.poll([])
    await settle()
    expect(h.fake.hellos[0]).toMatchObject({
      features: expect.arrayContaining(['connector-wake-v1'])
    })
    expect(polls()).toEqual([
      { v: 1, helloRev: 1 },
      { v: 1, helloRev: 1 }
    ])
    expect(h.wake.dialed).toHaveLength(0)
    client.stop()
  })

  it('with an offer but no wake token (an older auth service) polls as before', async () => {
    h.fake.wakeOffer = OFFER
    const { client } = h.startClient()
    await settle()
    h.poll([])
    await settle()
    expect(polls()).toEqual([
      { v: 1, helloRev: 1 },
      { v: 1, helloRev: 1 }
    ])
    expect(h.wake.dialed).toHaveLength(0)
    client.stop()
  })

  it('holds long-polls until the socket opens, then polls on wakes and the safety timer', async () => {
    const { client } = await onWake()
    const socket = h.wake.dialed[0]
    expect(socket.headers.authorization).toBe('Bearer wake-0')
    // The first poll went before the socket opened, held as today.
    expect(polls()[0]).toEqual({ v: 1, helloRev: 1 })
    await settle(60_000)
    expect(polls()).toHaveLength(2)
    socket.wake()
    await settle()
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1, holdMs: 2_000 })
    h.poll([])
    await settle(179_000)
    expect(polls()).toHaveLength(3)
    await settle(2_000)
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1, holdMs: 0 })
    client.stop()
  })

  it('polls once more after the cloud takes its acks, with no wake', async () => {
    const { client } = await onWake()
    h.wake.dialed[0].wake()
    await settle()
    h.poll([{ ...base, deliveryId: 'd1', kind: 'send', text: 'more' }])
    await settle()
    expect(h.fake.acks).toContainEqual({ deliveryId: 'd1', step: 'received' })
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1, holdMs: 0 })
    client.stop()
  })

  it('a replaced socket long-polls until the next hello and never redials', async () => {
    const { client } = await onWake()
    h.wake.dialed[0].end(4409)
    await settle()
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1 })
    h.poll([])
    await settle(10 * 60_000)
    expect(h.wake.dialed).toHaveLength(1)
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1 })
    client.stop()
  })

  it('a drop waits out its grace; three failed connects long-poll; a 401 renews once', async () => {
    const { client } = await onWake()
    const before = polls().length
    h.wake.dialed[0].end(1006)
    await settle(600)
    // A refused token renews and redials at once, and doesn't count.
    h.wake.last?.refuse(401)
    await settle()
    expect(h.wake.dialed).toHaveLength(3)
    expect(h.wake.last?.headers.authorization).toBe('Bearer wake-1')
    expect(h.wake.last?.headers['x-orca-wake-gap-ms']).toBeDefined()
    h.wake.last?.refuse(503, { 'retry-after': '1' })
    await settle(1_100)
    h.wake.last?.refuse(500)
    await settle(2_100)
    expect(polls()).toHaveLength(before)
    h.wake.last?.refuse(500)
    await settle()
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1 })
    client.stop()
  })
})
