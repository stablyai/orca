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
import { readJournalConnectorReplies } from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-read'
import {
  admit,
  asked,
  installReplyMatrix,
  NOW,
  start,
  stampOf
} from './connector-reply-matrix.test-fixture'
import type { EmptyRetrySend } from './external-conversation-reply-empty-retry'
import { conversationReplyFill } from './external-conversation-reply-fill'
import { staleRepliesSettled } from './external-conversation-reply-freshness'
import { retryAskerOf } from './external-conversation-turn-ends'

// Item 964 review C1, on the reply matrix's real journal, fill, recovery and outbox packer: what a
// request too old to post closes as, under which key, on which clock, and what it counts.

installReplyMatrix()

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const LATER = NOW + 25 * HOUR

type Process = ReturnType<typeof start>
type Filled = JournalConnectorReplyRow & { fill: NonNullable<JournalConnectorReplyRow['fill']> }

const continueBody = (claim: AgentJournalConnectorClaim): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue.' }],
  connectorClaim: claim
})

/** A process filling at `at`, started at `startedAt` (by default a restart just before). */
function startAt(at: number, options: Parameters<typeof start>[0] = {}): Process {
  vi.setSystemTime(at)
  return start({ processStartedAt: at - MINUTE, ...options })
}

/** These rows, as of a time: a turn row ended then. */
const endedAt = (items: AgentJournalRenderItem[], at: number) =>
  items.map((item) => ({ ...item, observedAt: at }))

const reasons = (p: Process) =>
  Object.fromEntries(
    readJournalConnectorReplies(p.db).map((row) => [
      row.deliveryId,
      row.fill?.expiredReason ?? null
    ])
  )

const owedEvents = async (journal: ConnectorReplyCutJournal, after: string | null, limit = 50) =>
  replyEventsOf(
    (await journal.readOwed('account-a', after, limit)).filter((row): row is Filled => !!row.fill)
  ).map((event) => ({
    ids: event.deliveryIds,
    answer: event.answerDeliveryId,
    outcome: event.outcome
  }))

/** The cloud accepted the owed event with this outcome: its delivery ids are sent, as
 *  ConnectorReplyOutbox.accepted marks them. */
async function accept(p: Process, outcome: string) {
  const event = (await owedEvents(p.journal, null)).find((owed) => owed.outcome === outcome)
  await p.journal.sent(event!.ids.map((deliveryId) => ({ account: 'account-a', deliveryId })))
}

/** d1 asked before the restart and claimed by c1; d2 a fresh steer in the same thread; c1's turn
 *  answers both. */
async function oldAndFresh() {
  const p = startAt(LATER)
  admit(p.db, 'm1', asked('d1'))
  p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted', 'Half.')])
  const claim = (await p.recovery.claimFor('chat-1', {
    turnId: 'provider-item:t1',
    kind: 'restart'
  }))!
  admit(p.db, 'c1', continueBody(claim))
  admit(p.db, 'm2', asked('d2'))
  p.db
    .prepare('UPDATE journal_connector_replies SET admitted_at=? WHERE delivery_id=?')
    .run(LATER, 'd2')
  await p.fillTurn({
    sessionId: 'chat-1',
    turnItemId: 'item:t2',
    stamps: [...claim.origin, stampOf('d2')],
    openerItemId: agentJournalSubmissionKey('c1'),
    outcome: 'success',
    prose: 'Both done.',
    bot: false,
    links: []
  })
  return p
}

describe('RR-C1-01: an old request closes under its own key, apart from a fresh answer', () => {
  it('fills them as two disjoint events, the fresh one under its own head', async () => {
    const p = await oldAndFresh()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'quiet', head: 'd1' },
      d2: { outcome: 'answered', prose: 'Both done.', head: 'd2' }
    })
    expect(await owedEvents(p.journal, null)).toEqual([
      { ids: ['d1'], answer: 'd1', outcome: 'quiet' },
      { ids: ['d2'], answer: 'd2', outcome: 'answered' }
    ])
  })

  it('keeps the quiet row when only the answer’s event is accepted, and replays just it', async () => {
    const p = await oldAndFresh()
    await accept(p, 'answered')
    expect(await owedEvents(p.journal, null)).toEqual([
      { ids: ['d1'], answer: 'd1', outcome: 'quiet' }
    ])
  })

  it('keeps the answer when only the quiet event is accepted, and replays just it', async () => {
    const p = await oldAndFresh()
    await accept(p, 'quiet')
    expect(await owedEvents(p.journal, null)).toEqual([
      { ids: ['d2'], answer: 'd2', outcome: 'answered' }
    ])
  })

  it('packs the same events a page at a time', async () => {
    const p = await oldAndFresh()
    expect([
      ...(await owedEvents(p.journal, null, 1)),
      ...(await owedEvents(p.journal, 'd1', 1))
    ]).toEqual(await owedEvents(p.journal, null))
  })
})

describe('RR-C1-02: only a restart starts a request’s clock, and a pause stays a pause', () => {
  it('answers a live hidden retry of a day-old request asked in this same process', async () => {
    const asks: AgentJournalMessageItem[] = []
    const send: EmptyRetrySend = async (_id, body) => (asks.push(body), 'accepted')
    const p = startAt(LATER, {
      processStartedAt: NOW - HOUR,
      bot: true,
      continuationsSettled: Promise.resolve(),
      retry: { send }
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'completed')])
    const stamps = [stampOf('d1')]
    const live = {
      sessionId: 'chat-1',
      stamps,
      bot: true,
      links: [],
      ...retryAskerOf(asked('d1'), stamps),
      outcome: 'success' as const,
      toolsRan: false,
      turnStartedAt: LATER - MINUTE,
      live: true as const
    }
    await p.fillTurn({
      ...live,
      turnItemId: 'item:t1',
      openerItemId: agentJournalSubmissionKey('m1'),
      prose: ''
    })
    admit(p.db, 'r1', asks[0]!)
    p.show([...p.items(), p.message('r1'), ...p.turn('item:t2', 'r1', 'completed', 'Here it is.')])
    await p.fillTurn({
      ...live,
      turnItemId: 'item:t2',
      openerItemId: agentJournalSubmissionKey('r1'),
      prose: 'Here it is.'
    })
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Here it is.', head: 'd1' } })
  })

  it('answers a paused request whose continuation a restart cut, however old', async () => {
    const at = NOW + 30 * HOUR
    const p = startAt(at, {
      continuationsSettled: Promise.resolve(),
      usageLimitDisposition: async () => 'pending'
    })
    admit(p.db, 'm1', asked('d1'))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'failed')])
    await p.limited('item:t1', 'm1', [stampOf('d1')])
    const resume = await p.recovery.claimFor('chat-1', { turnId: 'item:t1', kind: 'usage_limit' })
    admit(p.db, 'c1', continueBody(resume!))
    p.show([...p.items(), p.message('c1'), ...p.turn('item:t2', 'c1', 'interrupted')])
    const restart = await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t2',
      kind: 'restart'
    })
    expect(restart).toMatchObject({ cutKind: 'restart', origin: [{ deliveryId: 'd1' }] })
    admit(p.db, 'c2', continueBody(restart!))
    p.show([
      ...p.items(),
      p.message('c2'),
      ...endedAt(p.turn('item:t3', 'c2', 'completed', 'Resumed.'), at - MINUTE)
    ])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Resumed.', head: 'd1' } })
  })

  it('still closes a day-old request a restart left open, with no pause behind it', async () => {
    const p = startAt(LATER, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.show([
      p.message('m1'),
      ...endedAt(p.turn('item:t1', 'm1', 'completed', 'Done.'), LATER - MINUTE)
    ])
    await p.recovery.boot()
    expect(reasons(p).d1).toMatch(/^old_request: answered /)
  })
})

describe('RR-C1-03: a held answer is judged by when its turn ended', () => {
  const refused = (at: number) => {
    const send: EmptyRetrySend = async () => 'refused'
    return startAt(at, {
      processStartedAt: NOW - HOUR,
      bot: true,
      continuationsSettled: Promise.resolve(),
      retry: { send }
    })
  }
  const tool = (key: string, at: number): AgentJournalRenderItem => ({
    itemId: `tool-${key}`,
    revision: 1,
    sequence: at,
    observedAt: NOW + at,
    body: { kind: 'tool-call', name: 'Read', input: {}, state: 'completed' },
    turnScope: { kind: 'turn', turnItemId: key }
  })
  const heldEnd = async (p: Process) => {
    admit(p.db, 'm1', asked('d1'))
    const said = p.turn('item:t1', 'm1', 'completed', 'Here it is.')
    p.show([p.message('m1'), ...said.slice(0, 1), tool('item:t1', 60), ...said.slice(1)])
    const stamps = [stampOf('d1')]
    await p.fillTurn({
      sessionId: 'chat-1',
      stamps,
      prose: '',
      bot: true,
      links: [],
      ...retryAskerOf(asked('d1'), stamps),
      turnItemId: 'item:t1',
      openerItemId: agentJournalSubmissionKey('m1'),
      outcome: 'success',
      toolsRan: false,
      turnStartedAt: NOW,
      live: true
    })
    await p.publish()
  }

  it('closes quietly when the held turn ended over an hour before the refused retry settles', async () => {
    const p = refused(NOW + 2 * HOUR)
    await heldEnd(p)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'quiet', head: 'd1' } })
    expect(reasons(p).d1).toMatch(/^stale_answer: answered ended at /)
  })

  it('answers with the held words when that turn ended within the hour', async () => {
    const p = refused(NOW + 10 * MINUTE)
    await heldEnd(p)
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Here it is.', head: 'd1' } })
  })
})

describe('RR-C1-04: a request with no admission date never ages, on any path', () => {
  it('answers it at boot with a fresh answer, whatever its message’s age', async () => {
    const p = startAt(LATER, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1'))
    p.db.exec('UPDATE journal_connector_replies SET admitted_at=NULL')
    p.show([
      p.message('m1'),
      ...endedAt(p.turn('item:t1', 'm1', 'completed', 'Fresh.'), LATER - MINUTE)
    ])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({ d1: { outcome: 'answered', prose: 'Fresh.', head: 'd1' } })
  })

  it('tells its cut as interrupted, where a dated one a day old closes quietly', async () => {
    const p = startAt(LATER, { continuationsSettled: Promise.resolve() })
    admit(p.db, 'm1', asked('d1', ['d2']))
    p.db
      .prepare('UPDATE journal_connector_replies SET admitted_at=NULL WHERE delivery_id=?')
      .run('d1')
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    await p.recovery.boot()
    expect(p.outcomes()).toEqual({
      d1: { outcome: 'interrupted', head: 'd1' },
      d2: { outcome: 'quiet', head: 'd2' }
    })
  })
})

describe('RR-C1-07: only a close the journal holds is counted', () => {
  /** d1 and its carried d2, asked before the restart, claimed by the launch continuation c1. */
  const claimed = async () => {
    const p = startAt(LATER)
    admit(p.db, 'm1', asked('d1', ['d2']))
    p.show([p.message('m1'), ...p.turn('item:t1', 'm1', 'interrupted')])
    const claim = (await p.recovery.claimFor('chat-1', {
      turnId: 'provider-item:t1',
      kind: 'restart'
    }))!
    admit(p.db, 'c1', continueBody(claim))
    return { p, claim }
  }
  /** A fill of c1's turn over this journal, at LATER, by a process a restart started. */
  const fillOver = (journal: ConnectorReplyCutJournal, filled: () => void = () => {}) =>
    conversationReplyFill(() => journal, filled, undefined, undefined, undefined, {
      processStartedAt: LATER - MINUTE
    })
  const ended = (claim: AgentJournalConnectorClaim) => ({
    sessionId: 'chat-1',
    turnItemId: 'item:t2',
    stamps: claim.origin,
    openerItemId: agentJournalSubmissionKey('c1'),
    outcome: 'success' as const,
    prose: 'Late.',
    bot: false,
    links: []
  })

  it('counts only the rows its one batch changed when another writer took one first', async () => {
    const { p, claim } = await claimed()
    // Another writer settles d1 before this fill's batch reaches the writer.
    const racing: ConnectorReplyCutJournal = {
      ...p.journal,
      fillEach: async (fills, admit) => {
        await p.journal.fillOutcomes([
          {
            account: 'account-a',
            deliveryId: 'd1',
            expect: { claimMessageId: 'c1' },
            outcome: 'cancelled',
            answerDeliveryId: 'd1'
          }
        ])
        return await p.journal.fillEach(fills, admit)
      }
    }
    const before = staleRepliesSettled()
    await fillOver(racing)(ended(claim))
    expect(p.outcomes()).toMatchObject({ d1: { outcome: 'cancelled' }, d2: { outcome: 'quiet' } })
    expect(staleRepliesSettled() - before).toBe(1)
  })

  it('counts a close a running drain accepted and deleted right after its commit', async () => {
    const { p, claim } = await claimed()
    // The sender takes each committed row at once: no row is left to read back.
    const drained: ConnectorReplyCutJournal = {
      ...p.journal,
      fillEach: async (fills, admit) => {
        const changed = await p.journal.fillEach(fills, admit)
        await p.journal.sent(fills.map(({ account, deliveryId }) => ({ account, deliveryId })))
        return changed
      }
    }
    const before = staleRepliesSettled()
    await fillOver(drained)(ended(claim))
    expect(staleRepliesSettled() - before).toBe(2)
  })

  it('counts, and wakes the sender for, a batch that committed though its call threw', async () => {
    const { p, claim } = await claimed()
    const lost: ConnectorReplyCutJournal = {
      ...p.journal,
      fillEach: async (fills, admit) => {
        await p.journal.fillEach(fills, admit)
        throw new Error('lost acknowledgement')
      }
    }
    const filled = vi.fn()
    const before = staleRepliesSettled()
    await expect(fillOver(lost, filled)(ended(claim))).rejects.toThrow('lost acknowledgement')
    expect([staleRepliesSettled() - before, filled.mock.calls.length]).toEqual([2, 1])
  })

  it('counts and wakes nothing for a batch that never ran, and says so when it cannot tell', async () => {
    const { p, claim } = await claimed()
    const refused: ConnectorReplyCutJournal = {
      ...p.journal,
      fillEach: async () => {
        throw new Error('no write')
      }
    }
    // The probe after the failed call can't read either.
    const unreadable: ConnectorReplyCutJournal = {
      ...refused,
      probeExpired: async () => {
        throw new Error('no read')
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const filled = vi.fn()
    const before = staleRepliesSettled()
    await expect(fillOver(refused, filled)(ended(claim))).rejects.toThrow('no write')
    await expect(fillOver(unreadable, filled)(ended(claim))).rejects.toThrow('no write')
    expect([staleRepliesSettled() - before, filled.mock.calls.length]).toEqual([0, 0])
    expect(p.outcomes()).toEqual({ d1: { outcome: null }, d2: { outcome: null } })
    expect(
      warn.mock.calls.filter(([line]) => String(line).includes('may have closed'))
    ).toHaveLength(2)
    warn.mockRestore()
  })

  it('names the time it classified a close, not a commit time it cannot know', async () => {
    const { p, claim } = await claimed()
    await fillOver(p.journal)(ended(claim))
    expect(reasons(p).d1).toMatch(
      /^old_request: answered for a request admitted at .*, classified at /
    )
  })
})
