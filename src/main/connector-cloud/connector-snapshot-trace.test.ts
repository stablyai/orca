import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ConnectorEvent } from '../../shared/connectors/connector-cloud-contract'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorOutboxHead } from './connector-outbox'
import { ConnectorSnapshotTrace, type ConnectorSnapshotReason } from './connector-snapshot-trace'
import { ConnectorAccountTransport, type ConnectorToken } from './connector-transport'
import { setActiveSink } from '../observability/tracer'
import { ConnectorTurnEvents } from './connector-turn-events'

const NOW = 1_800_000_000_000
const DEADLINE_MS = 1_000
const CONVERSATION = { source: 'slack' as const, externalId: 'T1:C9:1:U5' }
const PROMPT = {
  kind: 'question' as const,
  promptId: 'p1',
  question: 'Merge?',
  options: [{ id: '1', label: 'Yes' }]
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const answer = (status: number): Response => new Response(null, { status })

/** A fake cloud: each fetch takes the next queued answer, or waits on one the test resolves later. */
function fakeCloud() {
  const answers: (Response | Promise<Response>)[] = []
  const mints: (ConnectorResult<ConnectorToken> | Promise<ConnectorResult<ConnectorToken>>)[] = []
  const fetches = { count: 0 }
  const token = (): ConnectorResult<ConnectorToken> => ({
    ok: true,
    value: { connectorToken: `t${Math.random()}`, expiresAt: Date.now() + 3_600_000 }
  })
  const transport = new ConnectorAccountTransport(
    'https://connector.test',
    async () => (mints.length > 0 ? await mints.shift()! : token()),
    async () => {
      fetches.count += 1
      return await (answers.shift() ?? answer(204))
    }
  )
  const mintFailure: ConnectorResult<ConnectorToken> = {
    ok: false,
    status: 503,
    error: null,
    retryAfterMs: null
  }
  return { transport, answers, mints, fetches, mintFailure }
}

let dir: string
let spans: { name: string; attributes: Record<string, unknown> }[]
let events: ConnectorTurnEvents

const sent = () => spans.filter((span) => span.name === 'connector.snapshot.sent')
const built = () => spans.filter((span) => span.name === 'connector.snapshot.built')

function snapshot(
  reason: ConnectorSnapshotReason,
  intendedHelloRev: number | null,
  conversations: ConversationSnapshot['conversations'] = [entry()]
): void {
  events.expectSnapshot({ reason, clientId: 'c1', intendedHelloRev })
  events.observe({ kind: 'snapshot', conversations })
}

function entry(
  fields: Partial<ConversationSnapshot['conversations'][number]> = {}
): ConversationSnapshot['conversations'][number] {
  return {
    conversation: CONVERSATION,
    worktreeId: 'w',
    paneKey: 'pane-1',
    agent: 'claude',
    working: false,
    prompt: PROMPT,
    turnId: null,
    activeAt: NOW,
    trace: { heard: 'none', prompt: 'restated', standing: 'unknown' },
    ...fields
  }
}

/** One events request for the outbox's head, as the poll client sends it. */
function post(
  cloud: ReturnType<typeof fakeCloud>,
  head: ConnectorOutboxHead<ConnectorEvent>
): Promise<ConnectorResult<undefined>> {
  return cloud.transport.call('/v1/events', { events: head.batch }, z.undefined(), {
    requests: events.requestsFor(head.batch)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: NOW })
  dir = mkdtempSync(join(tmpdir(), 'orca-snapshot-trace-'))
  spans = []
  events = new ConnectorTurnEvents(
    dir,
    'ada',
    new ConnectorSnapshotTrace((name, attributes) => spans.push({ name, attributes }), DEADLINE_MS)
  )
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('a snapshot’s built span', () => {
  it('says why it was taken and what each traced entry sent, without prompt text', () => {
    snapshot('inputs-changed', 7)
    snapshot('poll-409', 8)

    expect(built().map((span) => span.attributes.reason)).toEqual(['inputs-changed', 'poll-409'])
    expect(built().every((span) => span.attributes.clientId === 'c1')).toBe(true)
    expect(built()[0]?.attributes).toMatchObject({
      intendedHelloRev: 7,
      sent: 1,
      restated: 1,
      entries: [{ paneKey: 'pane-1', prompt: 'restated', promptId: 'p1', standing: 'unknown' }]
    })
    expect(JSON.stringify(spans)).not.toContain('Merge?')
  })

  it('reports an entry the byte cap left out as omitted, not sent', () => {
    const big = (paneKey: string) =>
      entry({ paneKey: paneKey + 'x'.repeat(120 * 1024), trace: undefined })
    snapshot('first', 1, [big('a'), big('b')])

    const [span] = built()
    expect(span?.attributes).toMatchObject({ sent: 1, omittedByBytes: 1 })
    expect(span?.attributes.entries).toEqual([
      expect.objectContaining({ prompt: 'downgraded' }),
      expect.objectContaining({ prompt: 'omitted-bytes' })
    ])
  })
})

describe('a snapshot’s sent span', () => {
  it('names the stamp the cloud accepted, not the revision current when it was built', async () => {
    const cloud = fakeCloud()
    snapshot('first', 17)
    const head = events.next(42)!
    expect((await post(cloud, head)).ok).toBe(true)
    events.accepted(head.stamp)

    expect(sent()).toEqual([
      {
        name: 'connector.snapshot.sent',
        attributes: expect.objectContaining({
          outcome: 'accepted',
          helloRev: 42,
          seq: 0,
          intendedHelloRev: 17,
          stampsMinted: 1,
          httpRequests: 1,
          lastStatus: 204,
          settled: true
        })
      }
    ])
  })

  it('supersedes the pre-hello snapshot, and accepts the hello’s own', async () => {
    const cloud = fakeCloud()
    snapshot('client-start', null)
    snapshot('first', 5)
    const head = events.next(5)!
    await post(cloud, head)
    events.accepted(head.stamp)

    expect(sent().map((span) => span.attributes.outcome)).toEqual(['never-sent', 'accepted'])
  })

  it('counts every POST of a 401 renewal, and none for a failed mint', async () => {
    const renewal = fakeCloud()
    renewal.answers.push(answer(401), answer(204))
    snapshot('first', 1)
    const head = events.next(1)!
    await post(renewal, head)
    events.accepted(head.stamp)
    expect(sent()[0]?.attributes).toMatchObject({ httpRequests: 2, authRetries: 1 })
    expect(renewal.fetches.count).toBe(2)

    const noToken = fakeCloud()
    noToken.mints.push(noToken.mintFailure)
    snapshot('silence', 2)
    const second = events.next(2)!
    expect((await post(noToken, second)).ok).toBe(false)
    expect(noToken.fetches.count).toBe(0)
    await post(noToken, second)
    events.accepted(second.stamp)
    expect(sent()[1]?.attributes).toMatchObject({
      httpRequests: 1,
      credentialMintFailures: 1,
      stampsMinted: 1
    })
  })

  it('counts a 401 whose renewal mint fails as one POST and one token failure', async () => {
    const cloud = fakeCloud()
    cloud.answers.push(answer(401))
    snapshot('first', 1)
    const head = events.next(1)!
    cloud.mints.push(
      { ok: true, value: { connectorToken: 'first', expiresAt: Date.now() + 3_600_000 } },
      cloud.mintFailure
    )
    await post(cloud, head)
    snapshot('post-409', 2)
    expect(sent()[0]?.attributes).toMatchObject({
      outcome: 'superseded',
      httpRequests: 1,
      credentialMintFailures: 1,
      lastStatus: 401
    })
  })

  it('counts a retried stamp’s POSTs under one stamp', async () => {
    const cloud = fakeCloud()
    cloud.answers.push(answer(503), answer(204))
    snapshot('first', 1)
    const head = events.next(1)!
    await post(cloud, head)
    const again = events.next(1)!
    expect(again.stamp).toBe(head.stamp)
    await post(cloud, again)
    events.accepted(again.stamp)

    expect(sent()[0]?.attributes).toMatchObject({ httpRequests: 2, stampsMinted: 1 })
  })
})

describe('a snapshot superseded while its request runs', () => {
  it('reports once that request lands, and says the cloud applied it', async () => {
    const cloud = fakeCloud()
    const late = deferred<Response>()
    cloud.answers.push(late.promise)
    snapshot('first', 1)
    const running = post(cloud, events.next(1)!)
    await vi.advanceTimersByTimeAsync(0)
    snapshot('post-409', 2)
    expect(sent()).toEqual([])

    late.resolve(answer(204))
    await running
    expect(sent()).toHaveLength(1)
    expect(sent()[0]?.attributes).toMatchObject({
      outcome: 'superseded',
      helloRev: 1,
      httpRequests: 1,
      settled: true,
      lateApplied: true
    })
  })

  it('reports a late refusal as not applied', async () => {
    const cloud = fakeCloud()
    const late = deferred<Response>()
    cloud.answers.push(late.promise)
    snapshot('first', 1)
    const running = post(cloud, events.next(1)!)
    await vi.advanceTimersByTimeAsync(0)
    snapshot('post-409', 2)
    late.resolve(answer(503))
    await running

    expect(sent()[0]?.attributes).toMatchObject({ lateApplied: false, lastStatus: 503 })
  })

  it('reports at the deadline, unsettled, if the request never lands, and once only', async () => {
    const cloud = fakeCloud()
    const late = deferred<Response>()
    cloud.answers.push(late.promise)
    snapshot('first', 1)
    const running = post(cloud, events.next(1)!)
    await vi.advanceTimersByTimeAsync(0)
    snapshot('post-409', 2)

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1)
    expect(sent()[0]?.attributes).toMatchObject({ settled: false, inFlight: 1, callsInFlight: 1 })
    late.resolve(answer(204))
    await running
    expect(sent()).toHaveLength(1)
  })

  it('waits for a call still minting its first token', async () => {
    const cloud = fakeCloud()
    const mint = deferred<ConnectorResult<ConnectorToken>>()
    cloud.mints.push(mint.promise)
    snapshot('first', 1)
    const running = post(cloud, events.next(1)!)
    await vi.advanceTimersByTimeAsync(0)
    snapshot('post-409', 2)
    expect(sent()).toEqual([])

    mint.resolve({ ok: true, value: { connectorToken: 't', expiresAt: Date.now() + 3_600_000 } })
    await running
    expect(sent()[0]?.attributes).toMatchObject({
      outcome: 'superseded',
      httpRequests: 1,
      lateApplied: true,
      settled: true
    })
  })

  it('waits for a call renewing its token after a 401', async () => {
    const cloud = fakeCloud()
    cloud.answers.push(answer(401), answer(204))
    const renewal = deferred<ConnectorResult<ConnectorToken>>()
    cloud.mints.push(
      { ok: true, value: { connectorToken: 'first', expiresAt: Date.now() + 3_600_000 } },
      renewal.promise
    )
    snapshot('first', 1)
    const running = post(cloud, events.next(1)!)
    await vi.advanceTimersByTimeAsync(0)
    snapshot('post-409', 2)
    expect(sent()).toEqual([])

    renewal.resolve({
      ok: true,
      value: { connectorToken: 't2', expiresAt: Date.now() + 3_600_000 }
    })
    await running
    expect(sent()[0]?.attributes).toMatchObject({
      httpRequests: 2,
      authRetries: 1,
      lateApplied: true
    })
  })

  it('bounds a superseded call still waiting on a token, even when no request is running', async () => {
    const cloud = fakeCloud()
    const mint = deferred<ConnectorResult<ConnectorToken>>()
    cloud.mints.push(mint.promise)
    snapshot('first', 1)
    const running = post(cloud, events.next(1)!)
    snapshot('post-409', 2)

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1)
    expect(sent()[0]?.attributes).toMatchObject({
      outcome: 'superseded',
      settled: false,
      inFlight: 0,
      callsInFlight: 1,
      httpRequests: 0
    })
    mint.resolve(cloud.mintFailure)
    await running
    expect(sent()).toHaveLength(1)
  })

  it('reports unsettled when the outbox is dropped with it pending', async () => {
    const cloud = fakeCloud()
    const late = deferred<Response>()
    cloud.answers.push(late.promise)
    snapshot('first', 1)
    const running = post(cloud, events.next(1)!)
    await vi.advanceTimersByTimeAsync(0)
    events.clear()

    expect(sent()[0]?.attributes).toMatchObject({ outcome: 'superseded', settled: false })
    late.resolve(answer(204))
    await running
    expect(sent()).toHaveLength(1)
  })
})

describe('a refused snapshot head', () => {
  const live = (paneKey: string): ConversationSnapshot['conversations'][number] =>
    entry({ paneKey, prompt: null, trace: undefined })

  it('counts a split only when the outbox actually halves the head', async () => {
    const cloud = fakeCloud()
    cloud.answers.push(answer(413), answer(204))
    events.useCloudFeatures(new Set(['workers']))
    snapshot('first', 1)
    for (const paneKey of ['b', 'c', 'd']) {
      events.observe({
        kind: 'workers',
        conversation: CONVERSATION,
        worktreeId: 'w',
        paneKey,
        running: true
      })
    }
    const head = events.next(1)!
    expect(head.batch.length).toBe(4)
    await post(cloud, head)
    events.refused(head.stamp)
    const halved = events.next(1)!
    expect(halved.batch.length).toBe(2)
    await post(cloud, halved)
    events.accepted(halved.stamp)

    expect(sent()[0]?.attributes).toMatchObject({ refusedSplits: 1, httpRequests: 2 })
  })

  it('never counts a stale refusal for a head no longer current', async () => {
    const cloud = fakeCloud()
    cloud.answers.push(answer(413))
    snapshot('first', 1, [live('a')])
    const head = events.next(1)!
    await post(cloud, head)
    snapshot('post-409', 2, [live('a')])
    events.refused(head.stamp)

    expect(sent()[0]?.attributes).toMatchObject({ outcome: 'superseded', refusedSplits: 0 })
  })

  it('reports a dropped single snapshot as dropped', async () => {
    const cloud = fakeCloud()
    cloud.answers.push(answer(400))
    snapshot('first', 1)
    const head = events.next(1)!
    await post(cloud, head)
    events.refused(head.stamp)

    expect(sent()[0]?.attributes).toMatchObject({ outcome: 'dropped', refusedSplits: 0 })
  })
})

it('C1-5: exports the mint failure counter through the production tracer', async () => {
  const exported: unknown[] = []
  setActiveSink({ push: (record) => exported.push(record), flush: () => {}, close: () => {} })
  try {
    events = new ConnectorTurnEvents(dir, 'ada')
    const cloud = fakeCloud()
    cloud.mints.push(cloud.mintFailure)
    snapshot('first', 1)
    const head = events.next(1)!
    await post(cloud, head)
    await post(cloud, head)
    events.accepted(head.stamp)
    expect(exported).toContainEqual(
      expect.objectContaining({
        name: 'connector.snapshot.sent',
        attributes: expect.objectContaining({ credentialMintFailures: 1, httpRequests: 1 })
      })
    )
    expect(JSON.stringify(exported)).not.toContain('connectorToken')
  } finally {
    setActiveSink(null)
  }
})
