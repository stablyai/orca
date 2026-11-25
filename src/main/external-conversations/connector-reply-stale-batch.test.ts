import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalConnectorClaim } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import {
  replyEventsOf,
  type ConnectorReplyCutJournal
} from '../connector-cloud/connector-reply-outbox'
import {
  admit,
  asked,
  installReplyMatrix,
  NOW,
  start,
  stampOf
} from './connector-reply-matrix.test-fixture'
import type { EmptyRetrySend } from './external-conversation-reply-empty-retry'
import { conversationReplyFill, recoveredLiveFill } from './external-conversation-reply-fill'
import { endRepliedTurn, retryAskerOf } from './external-conversation-turn-ends'
import type { EndedTurnReplies } from './external-conversation-reply-fill'

// Item 964 review C3, on the reply matrix's real journal, fill, recovery and outbox packer: a
// batch of fills commits whole or not at all, its owner is woken and keeps custody either way, and
// a retired turn end writes, holds, asks and wakes nothing.

installReplyMatrix()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const LATER = NOW + 25 * HOUR

type Filled = JournalConnectorReplyRow & { fill: NonNullable<JournalConnectorReplyRow['fill']> }

const continueBody = (claim: AgentJournalConnectorClaim): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue.' }],
  connectorClaim: claim
})

function startAt(at: number, options: Parameters<typeof start>[0] = {}) {
  vi.setSystemTime(at)
  return start({
    processStartedAt: at - MINUTE,
    continuationsSettled: Promise.resolve(),
    ...options
  })
}

const endedAt = (items: AgentJournalRenderItem[], at: number) =>
  items.map((item) => ({ ...item, observedAt: at }))

const owedEvents = async (journal: ConnectorReplyCutJournal) =>
  replyEventsOf(
    (await journal.readOwed('account-a', null, 50)).filter((row): row is Filled => !!row.fill)
  ).map((event) => ({
    ids: event.deliveryIds,
    answer: event.answerDeliveryId,
    outcome: event.outcome
  }))

/** A failure of every write that names d2, before it commits. */
const failsWithD2 = (journal: ConnectorReplyCutJournal): ConnectorReplyCutJournal => ({
  ...journal,
  fillOutcomes: async (fills, admit) => {
    if (fills.some((fill) => fill.deliveryId === 'd2')) {
      throw new Error('d2 failed')
    }
    return await journal.fillOutcomes(fills, admit)
  },
  fillEach: async (fills, admit) => {
    if (fills.some((fill) => fill.deliveryId === 'd2')) {
      throw new Error('d2 failed')
    }
    return await journal.fillEach(fills, admit)
  }
})

/** d1 asked before the restart, d2 carried with it but admitted after; both claimed by c1. */
async function oldAndFreshClaimed(options: Parameters<typeof start>[0] = {}) {
  const p = startAt(LATER, options)
  admit(p.db, 'm1', asked('d1', ['d2']))
  p.db
    .prepare('UPDATE journal_connector_replies SET admitted_at=? WHERE delivery_id=?')
    .run(LATER, 'd2')
  p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
  const claim = (await p.recovery.claimFor('chat-1', {
    turnId: 'provider-item:t1',
    kind: 'restart'
  }))!
  admit(p.db, 'c1', continueBody(claim))
  const ended = {
    sessionId: 'chat-1',
    turnItemId: 'item:t2',
    stamps: claim.origin,
    openerItemId: agentJournalSubmissionKey('c1'),
    outcome: 'success' as const,
    prose: 'Both done.',
    bot: false,
    links: []
  }
  // The turn as the journal records it, for recovery to fill from.
  const recorded = () =>
    p.show([
      ...p.items(),
      p.message('c1'),
      ...endedAt(p.turn('item:t2', 'c1', 'completed', 'Both done.'), LATER - MINUTE)
    ])
  return { p, ended, recorded }
}

describe('RR-C1-01: a fresh request never answers under an old one’s accepted quiet key', () => {
  it('commits nothing when one write fails, so recovery fills both under their own keys', async () => {
    const { p, ended, recorded } = await oldAndFreshClaimed()
    const live = conversationReplyFill(
      () => failsWithD2(p.journal),
      () => {},
      undefined,
      undefined,
      undefined,
      { processStartedAt: LATER - MINUTE }
    )
    await expect(live(ended)).rejects.toThrow('d2 failed')
    // Whatever committed, a sender accepts and deletes before recovery runs.
    const drained = await owedEvents(p.journal)
    await p.journal.sent(
      drained
        .flatMap((event) => event.ids)
        .map((deliveryId) => ({ account: 'account-a', deliveryId }))
    )
    recorded()
    await p.recovery.boot()
    const events = [...drained, ...(await owedEvents(p.journal))]
    expect(events.filter((event) => event.ids.includes('d2'))).toEqual([
      { ids: ['d2'], answer: 'd2', outcome: 'answered' }
    ])
    expect(events.filter((event) => event.ids.includes('d1'))).toEqual([
      { ids: ['d1'], answer: 'd1', outcome: 'quiet' }
    ])
  })
})

describe('RR-C1-07: the owner is woken for what committed, and keeps the rest', () => {
  it('wakes the sender for a live batch that committed though its call threw', async () => {
    let lost = true
    const filled = vi.fn()
    const { p, ended } = await oldAndFreshClaimed({
      filled,
      wrapJournal: (journal) => ({
        ...journal,
        fillEach: async (fills, admit) => {
          const changed = await journal.fillEach(fills, admit)
          if (lost) {
            lost = false
            throw new Error('lost acknowledgement')
          }
          return changed
        }
      })
    })
    await expect(recoveredLiveFill(p.fillTurn, p.recovery)(ended)).rejects.toThrow(
      'lost acknowledgement'
    )
    expect([filled.mock.calls.length, p.outcomes().d2?.outcome]).toEqual([1, 'answered'])
  })

  it('hands a live batch that failed before it committed to recovery, which fills and wakes', async () => {
    let failing = true
    const filled = vi.fn()
    const { p, ended, recorded } = await oldAndFreshClaimed({
      filled,
      wrapJournal: (journal) => ({
        ...journal,
        fillEach: async (fills, admit) => {
          if (failing) {
            failing = false
            throw new Error('no write')
          }
          return await journal.fillEach(fills, admit)
        }
      })
    })
    await expect(recoveredLiveFill(p.fillTurn, p.recovery)(ended)).rejects.toThrow('no write')
    expect([filled.mock.calls.length, p.outcomes().d2?.outcome]).toEqual([0, null])
    recorded()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'quiet', head: 'd1' },
      d2: { outcome: 'answered', prose: 'Both done.', head: 'd2' }
    })
    expect(filled).toHaveBeenCalled()
  })

  it('wakes for a recovery batch that committed though its call threw, and settles again later', async () => {
    let lost = true
    const filled = vi.fn()
    const { p, recorded } = await oldAndFreshClaimed({
      filled,
      wrapJournal: (journal) => ({
        ...journal,
        fillEach: async (fills, admit) => {
          const changed = await journal.fillEach(fills, admit)
          if (lost) {
            lost = false
            throw new Error('lost acknowledgement')
          }
          return changed
        }
      })
    })
    recorded()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await p.recovery.boot()
    expect([filled.mock.calls.length, p.outcomes().d2?.outcome]).toEqual([1, 'answered'])
    // The failed pass left a settle due: its rows keep an owner.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    warn.mockRestore()
  })
})

describe('RR-C1-08: a retired turn end writes, holds, asks and wakes nothing', () => {
  const asks: AgentJournalMessageItem[] = []
  const send: EmptyRetrySend = async (_id, body) => (asks.push(body), 'accepted')
  const emptyEnd = (current: () => boolean) => {
    const stamps = [stampOf('d1')]
    return {
      sessionId: 'chat-1',
      stamps,
      prose: '',
      bot: true,
      links: [],
      ...retryAskerOf(asked('d1'), stamps),
      turnItemId: 'item:t1',
      openerItemId: agentJournalSubmissionKey('m1'),
      outcome: 'success' as const,
      toolsRan: false,
      turnStartedAt: NOW,
      live: true as const,
      current
    }
  }

  it('sends no hidden retry when its turn end retired while the rows were held', async () => {
    asks.splice(0)
    let current = true
    const p = start({
      bot: true,
      retry: { send },
      wrapJournal: (journal) => ({
        ...journal,
        holdForRetry: async (rows, admit) => {
          const held = await journal.holdForRetry(rows, admit)
          current = false
          return held
        }
      })
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed')])
    await p.fillTurn(emptyEnd(() => current))
    expect([asks.length, p.outcomes().d1?.outcome]).toEqual([0, null])
  })

  it('writes, holds and wakes nothing for a turn end retired before it filled', async () => {
    asks.splice(0)
    const filled = vi.fn()
    const p = start({ bot: true, retry: { send }, filled })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed')])
    await p.fillTurn({ ...emptyEnd(() => false), prose: 'Done.' })
    expect([asks.length, filled.mock.calls.length, p.outcomes().d1?.outcome]).toEqual([0, 0, null])
  })

  it('wakes no sender for a write that committed after its turn end retired', async () => {
    let current = true
    const filled = vi.fn()
    const p = start({
      filled,
      wrapJournal: (journal) => ({
        ...journal,
        fillEach: async (fills, admit) => {
          const changed = await journal.fillEach(fills, admit)
          current = false
          return changed
        }
      })
    })
    admit(p.db, 'm1', asked('d1'))
    await p.fillTurn({
      sessionId: 'chat-1',
      turnItemId: 'item:t1',
      stamps: [stampOf('d1')],
      outcome: 'success',
      prose: 'Done.',
      bot: false,
      links: [],
      current: () => current
    })
    expect([p.outcomes().d1?.outcome, filled.mock.calls.length]).toEqual(['answered', 0])
  })

  it('hands the live turn end’s own lifetime to its fill', async () => {
    let reset = false
    const seen: EndedTurnReplies[] = []
    const end = {
      current: () => !reset,
      news: { sessionId: 'chat-1', outcome: 'success' },
      ended: { at: NOW },
      leave: { owed: false, settle: () => {} }
    }
    await endRepliedTurn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fill call reads only these fields.
      end as never,
      { stamps: [stampOf('d1')], turnItemId: 'item:t1' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a link without a bot is all the fill call reads.
      { bot: undefined } as never,
      async () => [],
      async (turn) => {
        seen.push(turn)
        return { covered: new Set(), paused: false }
      }
    )
    reset = true
    expect(seen[0]?.current?.()).toBe(false)
  })

  it('schedules nothing for a live end whose recovery was replaced while it filled', async () => {
    const p = start()
    const gate = Promise.withResolvers<void>()
    const live = recoveredLiveFill(async () => {
      await gate.promise
      return { covered: new Set(), paused: false }
    }, p.recovery)
    const filling = live({
      sessionId: 'chat-1',
      turnItemId: 'item:t1',
      stamps: [],
      outcome: 'success',
      prose: '',
      bot: false,
      links: []
    })
    p.recovery.dispose()
    void p.recovery.boot()
    await vi.advanceTimersByTimeAsync(0)
    const before = vi.getTimerCount()
    gate.resolve()
    await filling
    expect(vi.getTimerCount()).toBe(before)
  })
})
