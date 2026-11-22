import { describe, expect, it, vi } from 'vitest'
import { owedPage } from '../connector-cloud/connector-reply-journal.test-fixture'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { conversationReplyFill, type EndedTurnReplies } from './external-conversation-reply-fill'

// The real id of the 2026-11-20 case: the owner's DM with the bot.
const DM = { source: 'slack', externalId: 'T05BHT77GUF:D0CH5QFFC2C:D0CH5QFFC2C:U0CGB82KBC2' }

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

function fill(rows: JournalConnectorReplyRow[]) {
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
      () => {}
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

const stamp = (deliveryId: string, conversation = DM) => ({
  account: 'acct',
  conversation,
  deliveryId
})

describe('the conversations a turn answered with words', () => {
  it('still counts this turn’s answer once an earlier fill’s row was sent and deleted', async () => {
    const rows = [row('r1')]
    const f = fill(rows)
    const stamps = [stamp('r1')]
    // Recovery fills first; the cloud accepts it and the row is deleted.
    expect((await f.run(turn('Done.', stamps))).answered).toEqual(new Set([DM.externalId]))
    rows.length = 0
    // The live end of that same turn, later: no row left, the answer still counts.
    expect((await f.run(turn('Done.', stamps))).answered).toEqual(new Set([DM.externalId]))
    // Another turn does not inherit it.
    expect((await f.run({ ...turn('Done.', stamps), turnItemId: 'turn-2' })).answered).toEqual(
      new Set()
    )
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
