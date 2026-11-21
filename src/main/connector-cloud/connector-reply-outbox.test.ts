import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyKey,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorResult } from './connector-cloud-request'
import { ConnectorOutbox, ConnectorOutboxSender } from './connector-outbox'
import { conversationReplyFill } from '../external-conversations/external-conversation-reply-fill'
import {
  ConnectorReplyOutbox,
  type ConnectorReplyClient,
  type ConnectorReplyEvent,
  type ConnectorReplyJournal,
  type ConnectorReplyRoute
} from './connector-reply-outbox'

// Design item 125 §3 and §8, desktop sender: a turn's end fills its rows; filled rows go as reply
// events under the outbox, or through /replies under the kill switch; only acceptance sends them,
// and only the account that admitted them sends them.

afterEach(() => vi.useRealTimers())

const SLACK = { source: 'slack', externalId: 'slack:T1:C1:1.2' }

/** The journal's rows, with its first-fill-wins and sent semantics. */
function journal(rows: JournalConnectorReplyRow[]): ConnectorReplyJournal & {
  rows: JournalConnectorReplyRow[]
} {
  const find = (key: JournalConnectorReplyKey) =>
    rows.find((row) => row.account === key.account && row.deliveryId === key.deliveryId)
  return {
    rows,
    read: async (sessionId) =>
      rows.filter((row) => sessionId === undefined || row.sessionId === sessionId),
    fillOutcomes: async (fills: readonly JournalConnectorReplyFill[]) => {
      let changed = false
      for (const { account, deliveryId, ...fill } of fills) {
        const row = find({ account, deliveryId })
        if (row && !row.fill) {
          row.fill = { ...fill, filledAt: 50 }
          changed = true
        }
      }
      return changed
    },
    sent: async (keys) => {
      for (const key of keys) {
        rows.splice(rows.indexOf(find(key)!), 1)
      }
    }
  }
}

const row = (
  deliveryId: string,
  fill?: JournalConnectorReplyRow['fill'],
  account = 'account-a'
): JournalConnectorReplyRow => ({
  account,
  deliveryId,
  conversation: SLACK,
  sessionId: 'chat-1',
  epoch: 'e',
  messageId: `m-${deliveryId}`,
  queued: false,
  ...(fill ? { fill } : {})
})

const answered = (answerDeliveryId: string, prose = 'Done.') => ({
  outcome: 'answered' as const,
  answerDeliveryId,
  prose,
  filledAt: 40
})

function client() {
  const pushed: ConnectorReplyEvent[] = []
  const posted: unknown[] = []
  let postOk = true
  const sender: ConnectorReplyClient = {
    push: (events) => pushed.push(...events),
    post: async (body): Promise<ConnectorResult<unknown>> => {
      posted.push(body)
      return postOk
        ? { ok: true, value: { status: 'queued' } }
        : { ok: false, status: 503, error: null, retryAfterMs: null }
    },
    hostName: () => 'build-box'
  }
  return { sender, pushed, posted, failPosts: () => (postOk = false) }
}

/** A sender whose live route a test sets with each drain. */
function outbox(
  store: ConnectorReplyJournal,
  account = 'account-a',
  hooks: Partial<{ owed: () => void; wake: () => void }> = {}
) {
  const route: ConnectorReplyRoute = { client: null, outbox: undefined }
  const sender = new ConnectorReplyOutbox(account, () => store, {
    owed: () => {},
    wake: () => {},
    ...hooks,
    route: () => route
  })
  return Object.assign(sender, {
    route,
    via: (client: ConnectorReplyClient | null, capability: boolean | undefined) => {
      route.client = client
      route.outbox = capability
      return sender.drain()
    }
  })
}

describe('the turn end fill', () => {
  const stamp = (deliveryId: string, carried?: string[]) => ({
    account: 'account-a',
    conversation: SLACK,
    deliveryId,
    ...(carried ? { carried } : {})
  })
  const end = (
    fields: { outcome?: 'success' | 'failure'; prose?: string; bot?: boolean } = {}
  ) => ({
    sessionId: 'chat-1',
    turnItemId: 'turn-1',
    stamps: [stamp('d1', ['d2']), stamp('d3')],
    outcome: fields.outcome ?? 'success',
    prose: fields.prose ?? 'Here it is.',
    bot: fields.bot ?? false,
    links: []
  })

  it('fills every stamped row under the earliest unfilled one, and says the conversation is covered', async () => {
    const store = journal([row('d1'), row('d2'), row('d3'), row('other')])
    const covered = await conversationReplyFill(
      () => store,
      () => {}
    )(end())
    expect(covered).toEqual({ covered: new Set([SLACK.externalId]), paused: false })
    expect(
      store.rows.map((r) => [r.deliveryId, r.fill?.outcome, r.fill?.answerDeliveryId])
    ).toEqual([
      ['d1', 'answered', 'd1'],
      ['d2', 'answered', 'd1'],
      ['d3', 'answered', 'd1'],
      ['other', undefined, undefined]
    ])
  })

  it.each([
    ['a success that wrote nothing', { prose: '  ' }, 'no_answer'],
    ['a bot’s quiet marker', { prose: 'NO_REPLY', bot: true }, 'quiet'],
    ['a failure', { outcome: 'failure' as const }, 'failed']
  ])('fills %s as %s', async (_name, fields, outcome) => {
    const store = journal([row('d1')])
    await conversationReplyFill(
      () => store,
      () => {}
    )({ ...end(fields), stamps: [stamp('d1')] })
    expect(store.rows[0]?.fill?.outcome).toBe(outcome)
  })

  it('keeps how long an answered turn ran, and no length for a turn that wrote nothing', async () => {
    const fill = async (fields: Parameters<typeof end>[0]) => {
      const store = journal([row('d1')])
      await conversationReplyFill(
        () => store,
        () => {}
      )({ ...end(fields), stamps: [stamp('d1')], tookMs: 98_000 })
      return store.rows[0]?.fill
    }
    expect((await fill({}))?.tookMs).toBe(98_000)
    expect(await fill({ prose: '  ' })).not.toHaveProperty('tookMs')
    expect(await fill({ outcome: 'failure' })).not.toHaveProperty('tookMs')
  })

  it('keeps a row’s first fill and still names its conversation covered', async () => {
    const store = journal([row('d1', { ...answered('d1', 'First.'), filledAt: 1 })])
    const covered = await conversationReplyFill(
      () => store,
      () => {}
    )({
      ...end({ outcome: 'failure' }),
      stamps: [stamp('d1')]
    })
    expect(covered.covered.has(SLACK.externalId)).toBe(true)
    expect(store.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'First.' })
  })
})

describe('the sender', () => {
  it('pushes one event per answer, each naming its answer within the id cap, and sends only on acceptance', async () => {
    const ids = Array.from({ length: 150 }, (_, index) => `d${index}`)
    const store = journal(ids.map((id) => row(id, answered('d0'))))
    const sender = outbox(store)
    const { sender: c, pushed } = client()
    await sender.via(c, true)
    expect(pushed.map((event) => [event.deliveryIds.length, event.deliveryIds[0]])).toEqual([
      [100, 'd0'],
      [51, 'd0']
    ])
    // Pushed again before acceptance: nothing more goes.
    await sender.via(c, true)
    expect(pushed).toHaveLength(2)
    expect(store.rows).toHaveLength(150)
    await sender.accepted(pushed)
    expect(store.rows).toEqual([])
  })

  it('sends an answer with how long its turn ran, and one without when none was kept', async () => {
    const store = journal([
      row('d1', { ...answered('d1'), tookMs: 98_000 }),
      row('d2', answered('d2'))
    ])
    const { sender: c, pushed } = client()
    await outbox(store).via(c, true)
    expect(pushed.map((event) => [event.answerDeliveryId, event.tookMs])).toEqual([
      ['d1', 98_000],
      ['d2', undefined]
    ])
    expect(pushed[1]).not.toHaveProperty('tookMs')
  })

  it('lets go of events the transport dropped, so the next drain sends them again', async () => {
    const store = journal([row('d1', answered('d1'))])
    const sender = outbox(store)
    const { sender: c, pushed } = client()
    await sender.via(c, true)
    sender.forget(pushed)
    await sender.via(c, true)
    expect(pushed).toHaveLength(2)
  })

  it('drains through /replies under the kill switch, with the stable drain id and the answer key', async () => {
    const store = journal([
      row('d1', answered('d1')),
      row('d2', { outcome: 'interrupted', answerDeliveryId: 'd2', filledAt: 41 }),
      row('d3', { outcome: 'quiet', answerDeliveryId: 'd3', filledAt: 42 })
    ])
    const { sender: c, posted } = client()
    await outbox(store).via(c, false)
    expect(posted).toEqual([
      {
        replyId: 'outcome-i1NjnxUsj8bvMIAv3kYroL6c8IX3WA3Gnv1y4AKruzU',
        conversation: SLACK,
        turnId: 40,
        text: 'Done.',
        answerDeliveryId: 'd1'
      },
      {
        replyId: 'outcome-54gQPuFTGPzSr5tztOu7M6kDsCDeezB9cfX-0PQz5Ug',
        conversation: SLACK,
        turnId: 41,
        text: 'The agent on build-box stopped before it answered. Send again to retry.',
        answerDeliveryId: 'd2'
      }
    ])
    // A quiet row has nothing to post and is done.
    expect(store.rows).toEqual([])
  })

  it('keeps a row whose /replies post failed, and retries it later', async () => {
    vi.useFakeTimers()
    const store = journal([row('d1', answered('d1'))])
    const wake = vi.fn()
    const sender = outbox(store, 'account-a', { wake })
    const { sender: c, failPosts } = client()
    failPosts()
    await sender.via(c, false)
    expect(store.rows).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(wake).toHaveBeenCalledOnce()
  })

  it('sends only its own account’s rows, and nothing once that account is signed out', async () => {
    const store = journal([row('a1', answered('a1')), row('b1', answered('b1'), 'account-b')])
    const sender = outbox(store, 'account-b')
    const { sender: c, pushed } = client()
    await sender.via(c, true)
    expect(pushed.flatMap((event) => event.deliveryIds)).toEqual(['b1'])
    store.rows.push(row('b2', answered('b2'), 'account-b'))
    sender.retire()
    await sender.via(c, true)
    expect(pushed.flatMap((event) => event.deliveryIds)).toEqual(['b1'])
  })

  it('counts filled rows with no client yet, so the machine connects for them', async () => {
    const store = journal([row('d1', answered('d1')), row('d2')])
    const owed = vi.fn()
    const sender = outbox(store, 'account-a', { owed })
    await sender.via(null, undefined)
    expect(sender.owed).toBe(1)
    expect(owed).toHaveBeenCalledOnce()
  })
})

describe('the sender across hellos, accounts and refusals', () => {
  /** A journal whose next read alone waits until released. */
  function pausedReads(store: ReturnType<typeof journal>) {
    let release: () => void = () => {}
    const read = store.read
    store.read = (sessionId) => {
      store.read = read
      return new Promise((resolve) => {
        release = () => void read(sessionId).then(resolve)
      })
    }
    return () => release()
  }

  it('never hands rows to a hello the kill switch replaced during its read', async () => {
    const store = journal([row('d1', answered('d1'))])
    const release = pausedReads(store)
    const sender = outbox(store)
    const { sender: c, pushed, posted } = client()
    const drained = sender.via(c, true)
    // The switch goes off while the read is out: a new hello, no outbox.
    sender.route.outbox = false
    release()
    await drained
    expect(pushed).toEqual([])
    expect(posted).toHaveLength(1)
  })

  it('sends nothing once a count reconciles its account away', async () => {
    const store = journal([row('d1', answered('d1'))])
    let sender: ReturnType<typeof outbox> | null = null
    sender = outbox(store, 'account-a', { owed: () => sender?.retire() })
    const { sender: c, posted } = client()
    await sender.via(c, false)
    expect(posted).toEqual([])
    expect(store.rows).toHaveLength(1)
  })

  it('leaves A’s rows to A across A→B→A, the paused read sending nothing for B', async () => {
    const store = journal([row('a1', answered('a1')), row('b1', answered('b1'), 'account-b')])
    const release = pausedReads(store)
    const first = outbox(store, 'account-a')
    const { sender: c, pushed } = client()
    const paused = first.via(c, true)
    first.retire()
    const b = outbox(store, 'account-b')
    release()
    await paused
    expect(pushed).toEqual([])
    await b.via(c, true)
    expect(pushed.flatMap((event) => event.deliveryIds)).toEqual(['b1'])
    await outbox(store, 'account-a').via(c, true)
    expect(pushed.flatMap((event) => event.deliveryIds)).toEqual(['b1', 'a1'])
  })

  it('keeps draining past a row the cloud refused, and keeps that row', async () => {
    vi.useFakeTimers()
    const store = journal([row('d1', answered('d1')), row('d2', answered('d2'))])
    let calls = 0
    const c: ConnectorReplyClient = {
      push: () => {},
      post: async (): Promise<ConnectorResult<unknown>> =>
        ++calls === 1
          ? { ok: false, status: 409, error: 'reply_id_conflict', retryAfterMs: null }
          : { ok: true, value: { status: 'queued' } },
      hostName: () => 'build-box'
    }
    await outbox(store).via(c, false)
    expect(calls).toBe(2)
    expect(store.rows.map((r) => r.deliveryId)).toEqual(['d1'])
  })
})

describe('an outcome the cloud can’t stand up yet', () => {
  it('is set aside so the events behind it still go, its row kept for later', async () => {
    vi.useFakeTimers()
    const outbox = new ConnectorOutbox<string>({ headSize: () => 2 })
    outbox.push('stuck-reply', 'other', 'healthy-reply')
    const sent: string[][] = []
    const sender = new ConnectorOutboxSender<string>(
      outbox,
      async (batch) => {
        sent.push(batch)
        return batch.includes('stuck-reply')
          ? { ok: false, status: 503, error: 'reply_not_accepted', retryAfterMs: null }
          : null
      },
      () => 1,
      () => 0.5
    )
    sender.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([['stuck-reply', 'other'], ['stuck-reply'], ['other', 'healthy-reply']])
    expect(outbox.size).toBe(0)
  })
})
