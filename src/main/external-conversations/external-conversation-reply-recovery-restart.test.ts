import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asked,
  continued,
  HOUR,
  memoryOffers,
  MINUTE,
  restartFixture,
  row,
  said,
  submission,
  T0,
  turnRow,
  typed
} from './external-conversation-reply-recovery-restart.test-fixture'
import type { ReplyRecoveryOffers } from './external-conversation-reply-settle-pass'

// Design slack-reply-lost-restart: an Orca restart cuts the turn that took a Slack request (state
// interrupted, no outcome); the restart continuation's answer must fill that request's row, once,
// in its own thread, and a row whose answer or request is too old closes quietly.

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const CUT_AT = T0 + 4 * MINUTE
const ANSWERED_AT = T0 + 11 * MINUTE
const SESSION = 'chat-1'
const cutTurn = turnRow('t-cut', 2, 'd1', 'interrupted', T0, CUT_AT)

/** The incident's shape: asked, cut by a restart, continued, answered. */
const resumedChat = (restartOf = { kind: 'turn' as const, id: 'tid-t-cut' }) => ({
  items: [
    asked('d1', 1, T0),
    cutTurn,
    continued('c1', 3, CUT_AT + MINUTE, restartOf),
    turnRow('t-cont', 4, 'c1', 'completed', CUT_AT + MINUTE, ANSWERED_AT),
    said('Deployed to staging and production.', 5, ANSWERED_AT, 't-cont')
  ],
  submissions: [submission('c1', { origin: 'host' })]
})

describe('a restart-resumed Slack request', () => {
  it('is answered with the continuation’s answer, keyed by the original delivery', async () => {
    const f = restartFixture(resumedChat(), { rows: [row('d1', T0)], now: ANSWERED_AT + MINUTE })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({
      outcome: 'answered',
      answerDeliveryId: 'd1',
      prose: 'Deployed to staging and production.',
      turnItemId: 't-cont'
    })
  })

  it('binds by the cut turn’s row key too (a person’s Continue on a cut turn)', async () => {
    const f = restartFixture(resumedChat({ kind: 'turn-item', id: 't-cut' } as never), {
      rows: [row('d1', T0)],
      now: ANSWERED_AT + MINUTE
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('answered')
  })

  it('waits while the continuation runs, in the same pass as the cut, then answers once it ends', async () => {
    const running = {
      items: [
        asked('d1', 1, T0),
        cutTurn,
        continued('c1', 3, CUT_AT + MINUTE, { kind: 'turn', id: 'tid-t-cut' }),
        turnRow('t-cont', 4, 'c1', 'running', CUT_AT + MINUTE)
      ],
      submissions: []
    }
    const f = restartFixture(running, { rows: [row('d1', T0)], now: CUT_AT + 2 * MINUTE })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    expect(f.observers).toHaveLength(1)
    f.clock.now = ANSWERED_AT + MINUTE
    await f.publish(resumedChat())
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', answerDeliveryId: 'd1' })
  })

  it('holds the cut turn’s request while its restart offer stands, though a later turn ended', async () => {
    const offers = memoryOffers([{ sessionId: SESSION, work: { kind: 'turn', id: 'tid-t-cut' } }])
    const movedOn = {
      items: [
        asked('d1', 1, T0),
        cutTurn,
        asked('d2', 3, CUT_AT + MINUTE),
        turnRow('t2', 4, 'd2', 'completed', CUT_AT + MINUTE, CUT_AT + 2 * MINUTE)
      ],
      submissions: []
    }
    const f = restartFixture(movedOn, {
      rows: [row('d1', T0)],
      now: CUT_AT + 3 * MINUTE,
      offers: offers.source
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    // The offer is dismissed: no continuation can come, so the cut is told.
    offers.set([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.rows[0]?.fill?.outcome).toBe('interrupted')
  })

  it('holds a send the provider exited before taking while its offer stands, then answers from its continuation', async () => {
    const offers = memoryOffers([{ sessionId: SESSION, work: { kind: 'submission', id: 'd1' } }])
    const exited = submission('d1', {
      dispatchState: 'unknown',
      recovered: true,
      reason: 'provider_exited_before_acknowledgement',
      resolvedAt: CUT_AT
    })
    const f = restartFixture(
      { items: [asked('d1', 1, T0)], submissions: [exited] },
      { rows: [row('d1', T0)], now: CUT_AT + MINUTE, offers: offers.source }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    f.clock.now = ANSWERED_AT + MINUTE
    offers.set([])
    await f.publish({
      items: [
        asked('d1', 1, T0),
        continued('c1', 2, CUT_AT + MINUTE, { kind: 'submission', id: 'd1' }),
        turnRow('t-cont', 3, 'c1', 'completed', CUT_AT + MINUTE, ANSWERED_AT),
        said('Done.', 4, ANSWERED_AT, 't-cont')
      ],
      submissions: [exited]
    })
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'Done.' })
  })

  it('tells a cut request with no continuation and no offer as interrupted', async () => {
    const f = restartFixture(
      {
        items: [
          asked('d1', 1, T0),
          cutTurn,
          asked('d2', 3, CUT_AT + MINUTE),
          turnRow('t2', 4, 'd2', 'completed', CUT_AT + MINUTE, CUT_AT + 2 * MINUTE)
        ],
        submissions: []
      },
      { rows: [row('d1', T0)], now: CUT_AT + 3 * MINUTE }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('interrupted')
  })
})

describe('freshness of a recovered reply', () => {
  it('closes an old cut quietly with its reason, measured from the cut, not from when Orca looked', async () => {
    const f = restartFixture(
      { items: [asked('d1', 1, T0), cutTurn], submissions: [] },
      { rows: [row('d1', T0)], now: CUT_AT + 2 * HOUR }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'quiet' })
    expect(f.rows[0]?.fill?.expiredReason).toMatch(/^stale_answer: interruption resolved at /)
    expect(f.recovery.expired).toBe(1)
  })

  it('posts a fresh answer to a 3 h old request, and closes one to a 25 h old request', async () => {
    const shift = (window: ReturnType<typeof resumedChat>, by: number) => ({
      ...window,
      items: window.items.map((entry) => {
        const body = entry.body
        return {
          ...entry,
          observedAt: entry.itemId.includes('d1') ? entry.observedAt : entry.observedAt + by,
          body:
            body.kind === 'turn' && body.completedAt
              ? { ...body, completedAt: body.completedAt + by }
              : body
        }
      })
    })
    const recent = restartFixture(shift(resumedChat(), 3 * HOUR), {
      rows: [row('d1', T0)],
      now: ANSWERED_AT + 3 * HOUR + MINUTE
    })
    await recent.recovery.boot()
    expect(recent.rows[0]?.fill?.outcome).toBe('answered')
    const old = restartFixture(shift(resumedChat(), 25 * HOUR), {
      rows: [row('d1', T0)],
      now: ANSWERED_AT + 25 * HOUR + MINUTE
    })
    await old.recovery.boot()
    expect(old.rows[0]?.fill?.expiredReason).toMatch(/^old_request: success /)
  })

  it('dates a row an earlier build wrote by its message; one whose message is out of reach stays owed', async () => {
    const f = restartFixture(resumedChat(), {
      rows: [row('d1', undefined), { ...row('gone', undefined), messageId: 'gone' }],
      now: ANSWERED_AT + MINUTE
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('answered')
    // No message in the window carries 'gone': its age can't be read.
    expect(f.rows[1]?.fill).toBeUndefined()
  })

  it('ends a hold at its durable deadline, and a reboot does not extend it', async () => {
    const offers = memoryOffers([{ sessionId: SESSION, work: { kind: 'turn', id: 'tid-t-cut' } }])
    const window = { items: [asked('d1', 1, T0), cutTurn], submissions: [] }
    const f = restartFixture(window, {
      rows: [row('d1', T0)],
      now: CUT_AT + MINUTE,
      offers: offers.source
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    // Orca restarts again an hour before the cap: the new process holds only until the same cap.
    f.recovery.dispose()
    f.clock.now = CUT_AT + 23 * HOUR
    const again = f.make()
    await again.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    f.clock.now = CUT_AT + 24 * HOUR
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'quiet' })
    again.dispose()
  })
})

describe('a continuation the Slack mirror tells the thread', () => {
  const mirroredChat = {
    items: [
      asked('d1', 1, T0),
      cutTurn,
      continued('c1', 3, CUT_AT + MINUTE, { kind: 'turn', id: 'tid-t-cut' }),
      turnRow('t-cont', 4, 'c1', 'completed', CUT_AT + MINUTE, ANSWERED_AT),
      typed('owner-1', 5, CUT_AT + 2 * MINUTE),
      said('Deployed.', 6, ANSWERED_AT, 't-cont')
    ],
    submissions: []
  }

  it('closes the inherited request quietly when the mirror posts that turn', async () => {
    const mirrorsTo = vi.fn(() => true)
    const f = restartFixture(mirroredChat, {
      rows: [row('d1', T0)],
      now: ANSWERED_AT + MINUTE,
      mirrorsTo
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({
      outcome: 'quiet',
      expiredReason: 'continuation_mirrored'
    })
    expect(mirrorsTo).toHaveBeenCalledWith(SESSION, 'slack:T1:C1:1.2', ['orca:owner-1'])
  })

  it('answers it when the person typed only after it ended: the mirror holds that with the next turn', async () => {
    const late = {
      items: [
        asked('d1', 1, T0),
        cutTurn,
        continued('c1', 3, CUT_AT + MINUTE, { kind: 'turn', id: 'tid-t-cut' }),
        turnRow('t-cont', 4, 'c1', 'completed', CUT_AT + MINUTE, ANSWERED_AT),
        said('Deployed.', 5, ANSWERED_AT, 't-cont'),
        typed('owner-1', 6, ANSWERED_AT + MINUTE)
      ],
      submissions: []
    }
    const mirrorsTo = vi.fn(() => true)
    const f = restartFixture(late, {
      rows: [row('d1', T0)],
      now: ANSWERED_AT + 2 * MINUTE,
      mirrorsTo
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', prose: 'Deployed.' })
    expect(mirrorsTo).not.toHaveBeenCalled()
  })

  it('answers it when the chat does not mirror', async () => {
    const f = restartFixture(mirroredChat, {
      rows: [row('d1', T0)],
      now: ANSWERED_AT + MINUTE,
      mirrorsTo: () => false
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('answered')
  })
})

describe('the five stuck rows of 2026-11-18..20, as they are on disk', () => {
  // Each: a Slack request, its turn cut by a quit (interrupted, no outcome), later turns; three with
  // an earlier build's continuation (no restartOf). None may post when this build first boots.
  const shapes = [
    { name: 'dbcb6bf2', admitted: 1_795_203_315_486, cut: 1_795_203_546_310, continuation: true },
    { name: '74b33734', admitted: 1_795_149_896_397, cut: 1_795_152_310_000, continuation: true },
    { name: '1f7bf59f', admitted: 1_795_104_354_602, cut: 1_795_104_385_000, continuation: true },
    { name: '4e831ba0', admitted: 1_795_037_121_461, cut: 1_795_040_925_000, continuation: false },
    { name: 'b13d9aaf', admitted: 1_795_203_460_891, cut: 1_795_203_545_000, continuation: false }
  ]
  const BOOT = 1_795_230_000_000

  it.each(shapes)('$name closes quietly with a reason', async ({ admitted, cut, continuation }) => {
    const later = cut + 2 * MINUTE
    const items = [
      asked('d1', 1, admitted),
      turnRow('t-cut', 2, 'd1', 'interrupted', admitted, cut),
      ...(continuation
        ? [
            continued('legacy', 3, later),
            turnRow('t-cont', 4, 'legacy', 'completed', later, later + 5 * MINUTE),
            said('The answer.', 5, later + 5 * MINUTE, 't-cont')
          ]
        : [
            asked('other', 3, later),
            turnRow('t-other', 4, 'other', 'completed', later, later + MINUTE)
          ])
    ]
    const f = restartFixture(
      { items, submissions: [] },
      { rows: [row('d1', undefined)], now: BOOT }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('quiet')
    expect(f.rows[0]?.fill?.expiredReason).toMatch(/^(stale_answer|old_request): interruption /)
  })
})

describe('one post per answer across the mirror and the outbox, either order', () => {
  // The cloud keys the two paths apart (orca-cloud thread-posts.ts): a turn end's answer by
  // `fallback:<thread>:<turnId>`, a reply event by its answerDeliveryId. Modelled here as it decides:
  // each key posts once; a quiet reply posts nothing.
  const cloud = () => {
    const posted = new Set<string>()
    return {
      posted,
      turnEnded: (event: {
        externalId: string
        turnId: number | null
        lastAssistantMessage?: string
      }) => {
        if (event.lastAssistantMessage) {
          posted.add(`fallback:${event.externalId}:${event.turnId}`)
        }
      },
      reply: (event: {
        answerDeliveryId: string
        outcome: string
        conversation: { externalId: string }
      }) => {
        if (event.outcome !== 'quiet' && event.outcome !== 'unattributed') {
          posted.add(`answer:${event.conversation.externalId}:${event.answerDeliveryId}`)
        }
      }
    }
  }

  const mirroredTurnEnd = async (sink: ReturnType<typeof cloud>) => {
    const { endMirroredTurn } = await import('./external-conversation-turn-ends')
    const released = new Promise<void>((resolve) =>
      endMirroredTurn(
        {
          ended: {
            kind: 'turn-ended',
            source: 'slack',
            externalId: SLACK_THREAD,
            workspace: null,
            turnId: 7,
            stopReason: 'success',
            at: ANSWERED_AT
          } as never,
          news: {
            kind: 'turn-ended',
            sessionId: SESSION,
            outcome: 'success',
            readTurn: async () => ({ lastAssistantMessage: 'Deployed.' })
          } as never,
          agent: 'claude',
          emit: () => {},
          turnFor: () => ({}),
          workersChecked: async () => {},
          current: () => true
        },
        {
          release: (event) => {
            sink.turnEnded(event as never)
            resolve()
          }
        }
      )
    )
    await released
  }

  const SLACK_THREAD = 'slack:T1:C1:1.2'
  const chat = {
    items: [
      asked('d1', 1, T0),
      cutTurn,
      continued('c1', 3, CUT_AT + MINUTE, { kind: 'turn', id: 'tid-t-cut' }),
      turnRow('t-cont', 4, 'c1', 'completed', CUT_AT + MINUTE, ANSWERED_AT),
      typed('owner-1', 5, CUT_AT + 2 * MINUTE),
      said('Deployed.', 6, ANSWERED_AT, 't-cont')
    ],
    submissions: []
  }

  const outbox = async (sink: ReturnType<typeof cloud>, rows: ReturnType<typeof row>[]) => {
    const { replyEventsOf } = await import('../connector-cloud/connector-reply-outbox')
    const filled = rows.filter((candidate) => candidate.fill) as never[]
    replyEventsOf(filled).forEach((event) => sink.reply(event))
  }

  it.each(['mirror first', 'recovery first'])(
    '%s: the thread gets exactly one post',
    async (order) => {
      const sink = cloud()
      const f = restartFixture(chat, {
        rows: [row('d1', T0)],
        now: ANSWERED_AT + MINUTE,
        mirrorsTo: () => true
      })
      if (order === 'mirror first') {
        await mirroredTurnEnd(sink)
        await f.recovery.boot()
        await outbox(sink, f.rows)
      } else {
        await f.recovery.boot()
        await outbox(sink, f.rows)
        await mirroredTurnEnd(sink)
      }
      expect([...sink.posted]).toEqual([`fallback:${SLACK_THREAD}:7`])
    }
  )

  it('without a mirror, the outbox posts it once and no turn end carries it', async () => {
    const sink = cloud()
    const f = restartFixture(chat, {
      rows: [row('d1', T0)],
      now: ANSWERED_AT + MINUTE,
      mirrorsTo: () => false
    })
    await f.recovery.boot()
    await outbox(sink, f.rows)
    expect([...sink.posted]).toEqual([`answer:${SLACK_THREAD}:d1`])
  })
})

describe('what a continuation resumes, when it can’t be read or was refused', () => {
  it('keeps the cut request owed while the binding can’t be read, then answers once it can', async () => {
    const f = restartFixture(resumedChat(), { rows: [row('d1', T0)], now: ANSWERED_AT + MINUTE })
    const reads = f.chat.journalReads
    let failing = true
    f.chat.journalReads = async () => {
      const journal = await reads()
      return {
        ...journal,
        canonicalItemIds: async (ids: readonly string[]) => {
          if (failing) {
            throw new Error('journal reader busy')
          }
          return journal.canonicalItemIds(ids)
        }
      }
    }
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    failing = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'answered', answerDeliveryId: 'd1' })
  })

  it('tells the cut as interrupted when the agent refused the continuation', async () => {
    const refused = {
      items: [
        asked('d1', 1, T0),
        cutTurn,
        continued('c1', 3, CUT_AT + MINUTE, { kind: 'turn', id: 'tid-t-cut' })
      ],
      submissions: [submission('c1', { origin: 'host', dispatchState: 'rejected' })]
    }
    const f = restartFixture(refused, { rows: [row('d1', T0)], now: CUT_AT + 2 * MINUTE })
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('interrupted')
  })
})

describe('the whole answer, and a chain too long to follow', () => {
  it('answers with the reply the restart cut partway through, then the continuation’s', async () => {
    const window = resumedChat()
    // The cut turn was writing its reply when Orca quit: its last root item is its own prose.
    window.items.splice(2, 0, said('Staging is green; production is', 2.5, CUT_AT, 't-cut'))
    const f = restartFixture(window, { rows: [row('d1', T0)], now: ANSWERED_AT + MINUTE })
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.prose).toBe(
      'Staging is green; production is\n\nDeployed to staging and production.'
    )
  })

  it('releases the original request at once when the restart chain runs past its last hop', async () => {
    const items = [asked('d1', 1, T0), turnRow('t0', 2, 'd1', 'interrupted', T0, CUT_AT)]
    for (let hop = 1; hop <= 5; hop += 1) {
      const at = CUT_AT + hop * MINUTE
      items.push(continued(`c${hop}`, hop * 2 + 1, at, { kind: 'turn-item', id: `t${hop - 1}` }))
      items.push(turnRow(`t${hop}`, hop * 2 + 2, `c${hop}`, 'interrupted', at, at + 30_000))
    }
    const f = restartFixture(
      { items, submissions: [] },
      { rows: [row('d1', T0)], now: CUT_AT + 7 * MINUTE }
    )
    await f.recovery.boot()
    expect(f.rows[0]?.fill?.outcome).toBe('interrupted')
  })
})

describe('a pass that can’t finish, or that the offers moved under', () => {
  const cutOnly = { items: [asked('d1', 1, T0), cutTurn], submissions: [] }

  it('tries a failed settle at a hold’s deadline again, rather than leaving the request open', async () => {
    const offers = memoryOffers([{ sessionId: SESSION, work: { kind: 'turn', id: 'tid-t-cut' } }])
    const f = restartFixture(cutOnly, {
      rows: [row('d1', T0)],
      now: CUT_AT + MINUTE,
      offers: offers.source
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    const read = f.journal.read
    let failing = true
    f.journal.read = async () => {
      if (failing) {
        failing = false
        throw new Error('journal busy')
      }
      return read()
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.clock.now = CUT_AT + 24 * HOUR
    await vi.advanceTimersByTimeAsync(24 * HOUR)
    expect(failing).toBe(false)
    expect(f.rows[0]?.fill).toMatchObject({ outcome: 'quiet' })
  })

  it('keeps a cut owed when its offer is recorded just after the pass read the offers', async () => {
    const offers = memoryOffers([])
    const source = offers.source()
    let recorded = false
    const racing: ReplyRecoveryOffers = {
      read: async (now) => {
        const read = await source.read(now)
        if (!recorded) {
          // A crash cut's offer is recorded at startup, right after this pass looked.
          recorded = true
          offers.set([{ sessionId: SESSION, work: { kind: 'turn', id: 'tid-t-cut' } }])
        }
        return read
      },
      onChange: source.onChange
    }
    const f = restartFixture(cutOnly, {
      rows: [row('d1', T0)],
      now: CUT_AT + MINUTE,
      offers: () => racing
    })
    await f.recovery.boot()
    expect(f.rows[0]?.fill).toBeUndefined()
    // The next pass sees the offer and holds for its continuation.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(recorded).toBe(true)
    expect(f.rows[0]?.fill).toBeUndefined()
  })
})
