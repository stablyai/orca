import { describe, expect, it, vi } from 'vitest'
import { owedPage } from '../connector-cloud/connector-reply-journal.test-fixture'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import {
  conversationReplyFill,
  journalAskedByOwner,
  type AskedByOwner,
  type EndedTurnReplies
} from './external-conversation-reply-fill'

// The real ids of the 2026-11-20 case: the owner's DM with the bot, and a channel thread.
const DM = { source: 'slack', externalId: 'T05BHT77GUF:D0CH5QFFC2C:D0CH5QFFC2C:U0CGB82KBC2' }
const THREAD = {
  source: 'slack',
  externalId: 'T05BHT77GUF:C0CCNS3K8BU:1795218253.690759:U0CGB82KBC2'
}

// The final messages the bot wrote that day, each ending with the marker its mail turns end with.
const STEERED_DM_ANSWER = [
  "I started fixes for Neil's items. The Codex restarts of my rail and permission-label authors also launched, after Claude's 5-hour limit hit.",
  '',
  '- **#45503 (failing CI):** A Codex worker is finding why its own change breaks the test.',
  '',
  "I won't merge anything without your go-ahead.",
  '',
  'NO_REPLY'
].join('\n')
const DM_TURN_ANSWER = [
  "You're right. I was answering only in the Orca chat and not in this DM. I couldn't post the status here directly just now, so this is the reply.",
  '',
  '- **Needs you:** A worker saw a live Stripe credential in a tool output. Please rotate it.',
  '',
  'NO_REPLY'
].join('\n')

function row(deliveryId: string, conversation = DM): JournalConnectorReplyRow {
  return {
    account: 'acct',
    deliveryId,
    conversation,
    sessionId: 'bot-chat',
    epoch: 'e1',
    messageId: `msg-${deliveryId}`,
    queued: false
  }
}

function fill(rows: JournalConnectorReplyRow[], askedByOwner?: AskedByOwner) {
  const filled: JournalConnectorReplyFill[] = []
  const store = {
    read: vi.fn(async () => rows),
    readOwed: vi.fn(async (account: string, after: string | null, limit: number) =>
      owedPage(rows, account, after, limit)
    ),
    fillOutcomes: vi.fn(async (fills: readonly JournalConnectorReplyFill[]) => {
      filled.push(...fills)
      return fills.length > 0
    }),
    sent: vi.fn(async () => {})
  }
  return {
    filled,
    run: conversationReplyFill(
      () => store,
      () => {},
      undefined,
      askedByOwner
    )
  }
}

const turn = (prose: string, stamps: EndedTurnReplies['stamps']): EndedTurnReplies => ({
  sessionId: 'bot-chat',
  turnItemId: 'turn-1',
  stamps,
  outcome: 'success',
  prose,
  bot: true,
  links: []
})

// The journal marks the deliveries the bot's owner sent (connectorReplyTurnStamps).
const stamp = (deliveryId: string, conversation = DM, ownerAsked = true) => ({
  account: 'acct',
  conversation,
  deliveryId,
  ...(ownerAsked ? { ownerAsked: true as const } : {})
})

describe('a bot turn’s answer to its owner’s DM', () => {
  it('posts the 22:41Z answer of a mail turn the DM was steered into, without its marker', async () => {
    const { filled, run } = fill([row('slack:dm:1795214376.705819')])
    await run(turn(STEERED_DM_ANSWER, [stamp('slack:dm:1795214376.705819')]))
    expect(filled).toEqual([
      expect.objectContaining({
        deliveryId: 'slack:dm:1795214376.705819',
        outcome: 'answered',
        prose: STEERED_DM_ANSWER.replace(/\n\nNO_REPLY$/, '')
      })
    ])
  })

  it('posts the 23:55Z answer of a turn the DM opened, without its marker', async () => {
    const { filled, run } = fill([row('slack:dm:1795218917.489689')])
    await run(turn(DM_TURN_ANSWER, [stamp('slack:dm:1795218917.489689')]))
    expect(filled[0]).toMatchObject({
      outcome: 'answered',
      prose: DM_TURN_ANSWER.replace(/\n\nNO_REPLY$/, '')
    })
    expect(filled[0]?.prose).not.toContain('NO_REPLY')
  })

  it('keeps a reply that is only the marker quiet', async () => {
    const { filled, run } = fill([row('d1')])
    await run(turn('NO_REPLY', [stamp('d1')]))
    expect(filled).toEqual([expect.objectContaining({ outcome: 'quiet' })])
    expect(filled[0]).not.toHaveProperty('prose')
  })

  it('keeps a member’s DM to today’s rule: words before the marker stay private', async () => {
    const { filled, run } = fill([row('m1')])
    await run(turn('Owner-only note on #12.\n\nNO_REPLY', [stamp('m1', DM, false)]))
    expect(filled).toEqual([expect.objectContaining({ outcome: 'quiet' })])
    expect(filled[0]).not.toHaveProperty('prose')
  })

  it('decides per request: the DM gets the words, a thread the same turn answered stays quiet', async () => {
    const { filled, run } = fill([row('t1', THREAD), row('d1')])
    await run(turn('Nothing new here.\n\nNO_REPLY', [stamp('t1', THREAD), stamp('d1')]))
    expect(filled).toEqual([
      expect.objectContaining({ deliveryId: 't1', outcome: 'quiet' }),
      expect.objectContaining({ deliveryId: 'd1', outcome: 'answered', prose: 'Nothing new here.' })
    ])
    expect(filled[0]).not.toHaveProperty('prose')
  })
})

describe('the owner proof of a row its stamps don’t mark', () => {
  const asker = (role: 'owner' | 'member') => ({
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [],
    asker: {
      source: 'slack' as const,
      userId: 'U1',
      role,
      place: { kind: 'direct_message' as const, id: 'D1' }
    }
  })

  it('reads the admitting send, or the send a queued card was handed over as', async () => {
    const bodies: Record<string, ReturnType<typeof asker> | undefined> = {
      's-owner': asker('owner'),
      's-member': asker('member')
    }
    // The card's own id names no send; the family read finds the send it became.
    const family: Record<string, string> = { 'card-owner': 's-owner', 'card-member': 's-member' }
    const submissionBody = vi.fn(
      async (id: string, read?: { family?: true }) =>
        bodies[id] ?? (read?.family ? bodies[family[id] ?? ''] : undefined) ?? null
    )
    const owned = journalAskedByOwner(async () => ({ submissionBody }))
    expect(await owned('chat', 's-owner')).toBe(true)
    expect(await owned('chat', 'card-owner')).toBe(true)
    expect(await owned('chat', 's-member')).toBe(false)
    expect(await owned('chat', 'card-member')).toBe(false)
    expect(await owned('chat', 'unknown')).toBe(false)
    expect(submissionBody).toHaveBeenCalledWith('card-owner', { family: true })
  })

  it('reads only when the marker could silence the answer, and a quiet answer counts as none', async () => {
    const askedByOwner = vi.fn<AskedByOwner>(async () => true)
    const unmarked = { account: 'acct', conversation: DM, deliveryId: 'r1' }
    const plain = fill([row('r1')], askedByOwner)
    await plain.run(turn('All done.', [unmarked]))
    await plain.run({ ...turn('Done.\n\nNO_REPLY', [unmarked]), outcome: 'failure' })
    await plain.run({ ...turn('Done.\n\nNO_REPLY', [unmarked]), bot: false })
    expect(askedByOwner).not.toHaveBeenCalled()
    const marked = fill([row('r1')], askedByOwner)
    const words = await marked.run(turn('Done.\n\nNO_REPLY', [unmarked]))
    expect(askedByOwner).toHaveBeenCalledWith('bot-chat', 'msg-r1')
    expect(marked.filled[0]).toMatchObject({ outcome: 'answered', prose: 'Done.' })
    expect(words.answered).toEqual(new Set([DM.externalId]))
    const quiet = await fill([row('r2')], askedByOwner).run(
      turn('NO_REPLY', [{ ...unmarked, deliveryId: 'r2' }])
    )
    expect(quiet.answered).toEqual(new Set())
  })

  it('still counts this turn’s answer once an earlier fill’s row was sent and deleted', async () => {
    const rows = [row('r1')]
    const f = fill(rows)
    const stamps = [
      { account: 'acct', conversation: DM, deliveryId: 'r1', ownerAsked: true as const }
    ]
    // Recovery fills first; the cloud accepts it and the row is deleted.
    expect((await f.run(turn('Done.\n\nNO_REPLY', stamps))).answered).toEqual(
      new Set([DM.externalId])
    )
    rows.length = 0
    // The live end of that same turn, later: no row left, the answer still counts.
    expect((await f.run(turn('Done.\n\nNO_REPLY', stamps))).answered).toEqual(
      new Set([DM.externalId])
    )
    // Another turn does not inherit it.
    expect(
      (await f.run({ ...turn('Done.\n\nNO_REPLY', stamps), turnItemId: 'turn-2' })).answered
    ).toEqual(new Set())
  })

  it('counts a row an earlier fill already answered for this turn, but not one of another turn', async () => {
    const filledBy = (turnItemId: string): JournalConnectorReplyRow => ({
      ...row('r1'),
      fill: { outcome: 'answered', answerDeliveryId: 'r1', turnItemId, prose: 'Done.', filledAt: 1 }
    })
    const stamps = [{ account: 'acct', conversation: DM, deliveryId: 'r1' }]
    expect(
      (await fill([filledBy('turn-1')]).run(turn('Done.\n\nNO_REPLY', stamps))).answered
    ).toEqual(new Set([DM.externalId]))
    expect(
      (await fill([filledBy('turn-0')]).run(turn('Done.\n\nNO_REPLY', stamps))).answered
    ).toEqual(new Set())
  })
})
