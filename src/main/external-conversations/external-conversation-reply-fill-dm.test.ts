import { describe, expect, it, vi } from 'vitest'
import type {
  JournalConnectorReplyFill,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { conversationReplyFill, type EndedTurnReplies } from './external-conversation-reply-fill'

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

function fill(rows: JournalConnectorReplyRow[]) {
  const filled: JournalConnectorReplyFill[] = []
  const store = {
    read: vi.fn(async () => rows),
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
