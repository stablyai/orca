import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  readBotActingTurn,
  type BotActingTurnLookups,
  type BotWakingPlace
} from './bot-request-asker'

const THREAD: BotWakingPlace = {
  source: 'slack',
  placeId: 'slack:T1:C1:1795415167.287389',
  url: 'https://example.slack.com/archives/C1/p1795415167287389'
}
const OTHER: BotWakingPlace = {
  source: 'slack',
  placeId: 'slack:T1:C1:1795415480.939339',
  url: 'https://example.slack.com/archives/C1/p1795415480939339'
}

const row = (body: AgentJournalItemBody): AgentJournalRenderItem => ({
  itemId: 'm1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body
})

const automationPrompt = row({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'A new top-level post in #perf.' }],
  memorySource: 'automation:a1'
})

const requestMail = (messageIds: string[]): AgentJournalRenderItem =>
  row({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'handoff' }],
    from: {
      kind: 'agent',
      senders: [],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'chat',
        dispatchId: null,
        messages: messageIds.map((messageId) => ({ messageId, runId: 'r1', from: 'desk' }))
      }
    }
  })

const lookups = (
  places: Record<string, BotWakingPlace>,
  woken: BotWakingPlace | null = null
): BotActingTurnLookups => ({
  isBotRequest: (messageId) => messageId in places,
  botRequestActsFor: (messageId) => ({
    askers: [{ kind: 'owner' }],
    originPlace: places[messageId]
  }),
  conversationActsFor: [{ kind: 'owner' }],
  automationPlace: () => woken,
  conversationWorkspaceId: null
})

describe('where a bot turn’s work started', () => {
  it('follows the work from the thread that woke a run into the chat it was handed to', () => {
    expect(readBotActingTurn([automationPrompt], lookups({}, THREAD)).originPlace).toEqual(THREAD)
    expect(
      readBotActingTurn([requestMail(['msg_a'])], lookups({ msg_a: THREAD })).originPlace
    ).toEqual(THREAD)
  })

  it('names no place when the requests a turn took started in different threads', () => {
    const turn = readBotActingTurn(
      [requestMail(['msg_a', 'msg_b'])],
      lookups({ msg_a: THREAD, msg_b: OTHER })
    )
    expect(turn.originPlace).toBeUndefined()
  })
})
