import { describe, expect, it, vi } from 'vitest'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { base, pollClientHarness, settle } from './connector-poll-client.test-fixture'
import { FAKE_BOT } from './fake-connector-seam.test-fixture'

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
    h.fake.holdBefore.add(CONNECTOR_PATHS.acks)
    const before = polls().length
    h.poll([{ ...base, deliveryId: 'd1', kind: 'send', text: 'more' }])
    await settle()
    // Sent but not yet taken: no poll yet.
    expect(h.fake.requestsTo(CONNECTOR_PATHS.acks)).toHaveLength(1)
    expect(polls()).toHaveLength(before)
    h.fake.release(CONNECTOR_PATHS.acks)
    await settle()
    expect(h.fake.acks).toContainEqual({ deliveryId: 'd1', step: 'received' })
    expect(polls()).toHaveLength(before + 1)
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1, holdMs: 0 })
    client.stop()
  })

  it('a changed hello polls under it at once, not at the safety poll', async () => {
    const { client, machine } = await onWake()
    const before = polls().length
    machine.botList = [FAKE_BOT]
    client.sayChanged()
    await settle(1_000)
    expect(h.fake.hellos).toHaveLength(2)
    expect(polls()).toHaveLength(before + 1)
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 2, holdMs: 0 })
    expect(h.wake.dialed).toHaveLength(1)
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

  it('sends a keepalive every 25 s and redials after two go unanswered', async () => {
    const { client } = await onWake()
    const socket = h.wake.dialed[0]
    socket.autoAck = false
    await settle(25_000)
    expect(socket.sent).toEqual(['{"type":"keepalive"}'])
    await settle(24_000)
    expect(socket.closed).toBe(false)
    await settle(27_000)
    expect(socket.closed).toBe(true)
    await settle(1_000)
    expect(h.wake.dialed).toHaveLength(2)
    client.stop()
  })

  it('a keepalive tick held back (App Nap) is not a miss; its ack keeps the socket', async () => {
    const { client } = await onWake()
    const socket = h.wake.dialed[0]
    socket.autoAck = false
    await settle(50_000)
    // One keepalive already unanswered; the process then doesn't run for 40 s.
    vi.setSystemTime(Date.now() + 40_000)
    await settle(25_000)
    expect(socket.closed).toBe(false)
    socket.emit('message', Buffer.from('{"type":"keepalive-ack"}'))
    await settle(25_000)
    expect(socket.closed).toBe(false)
    client.stop()
  })

  it('a dropped socket keeps polls unheld for 10 s, then long-polls', async () => {
    const { client } = await onWake()
    const before = polls().length
    h.wake.dialed[0].end(1006)
    await settle(9_000)
    // Redialing, not yet open.
    expect(h.wake.dialed).toHaveLength(2)
    expect(polls()).toHaveLength(before)
    await settle(2_000)
    expect(polls()).toHaveLength(before + 1)
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1 })
    client.stop()
  })

  it('renews a wake token with under a minute left before it dials', async () => {
    h.fake.wakeTokenTtlMs = 120_000
    const { client } = await onWake()
    await settle(70_000)
    h.wake.dialed[0].end(1006)
    await settle(1_000)
    expect(h.wake.dialed).toHaveLength(2)
    expect(h.wake.last?.headers.authorization).toBe('Bearer wake-1')
    client.stop()
  })

  it('a failed wake poll goes again after the backoff, not at the safety poll', async () => {
    const { client } = await onWake()
    h.wake.dialed[0].wake()
    await settle()
    const before = polls().length
    h.fake.answerPoll({ status: 503, body: { error: 'unavailable' } })
    await settle(21_000)
    expect(polls()).toHaveLength(before + 1)
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1, holdMs: 0 })
    client.stop()
  })

  it('a wake-token mint that fails just now backs off and dials again', async () => {
    const { client } = await onWake()
    h.fake.mintRefusal = 'unavailable'
    h.wake.dialed[0].end(4401)
    await settle(100)
    expect(h.wake.dialed).toHaveLength(1)
    h.fake.mintRefusal = null
    await settle(2_000)
    expect(h.wake.dialed).toHaveLength(2)
    expect(h.wake.last?.headers.authorization).toBe('Bearer wake-1')
    client.stop()
  })

  it('a shares_changed frame re-reads shares and polls nothing; a wake still polls', async () => {
    const sharesChanged = vi.fn()
    h.fake.wakeOffer = OFFER
    h.fake.mintsWakeTokens = true
    const { client } = h.startClient(undefined, undefined, (machine) => {
      machine.sharesChanged = sharesChanged
    })
    await settle()
    expect(h.fake.hellos[0]).toMatchObject({
      features: expect.arrayContaining(['shares-changed-v1'])
    })
    h.wake.last?.accept()
    h.poll([])
    await settle()
    h.poll([])
    await settle()
    const before = polls().length
    h.wake.last?.sharesChanged()
    await settle()
    expect(sharesChanged).toHaveBeenCalledTimes(1)
    expect(polls()).toHaveLength(before)
    h.wake.last?.wake()
    await settle()
    expect(polls()).toHaveLength(before + 1)
    expect(polls().at(-1)).toEqual({ v: 1, helloRev: 1, holdMs: 2_000 })
    expect(sharesChanged).toHaveBeenCalledTimes(1)
    client.stop()
  })

  it('a machine that does not take shares_changed neither lists it nor polls on it', async () => {
    const { client } = await onWake()
    expect(h.fake.hellos[0]).toMatchObject({
      features: expect.not.arrayContaining(['shares-changed-v1'])
    })
    const before = polls().length
    h.wake.dialed[0].sharesChanged()
    await settle()
    expect(polls()).toHaveLength(before)
    client.stop()
  })
})
