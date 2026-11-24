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
  placeId: 'C1',
  url: 'https://example.slack.com/archives/C1/p1795415167287389'
}
const OTHER: BotWakingPlace = {
  source: 'slack',
  placeId: 'C1',
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

const personMessage = row({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'why is it slow?' }],
  origin: 'connector',
  asker: {
    source: 'slack',
    userId: 'U1',
    role: 'owner',
    place: { kind: 'channel', id: 'C1' },
    url: THREAD.url
  }
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
  it('follows work from the thread that woke a run into the chat it was handed to, and no further', () => {
    expect(readBotActingTurn([automationPrompt], lookups({}, THREAD)).originPlace).toEqual(THREAD)
    // An automation whose results go elsewhere (none, its Chat, another channel) names no thread.
    const elsewhere: BotWakingPlace = { ...THREAD, resultsElsewhere: true }
    expect(readBotActingTurn([automationPrompt], lookups({}, elsewhere)).originPlace).toBe(
      undefined
    )
    // A person's message in a thread is that thread.
    expect(readBotActingTurn([personMessage], lookups({})).originPlace).toEqual({
      source: 'slack',
      placeId: 'C1',
      url: THREAD.url
    })
    expect(
      readBotActingTurn([requestMail(['msg_a'])], lookups({ msg_a: THREAD })).originPlace
    ).toEqual(THREAD)
    // A turn only a worker's report woke reads the turn before it, but never takes its thread.
    const report = { ...requestMail(['msg_report']), itemId: 'm2', sequence: 2 }
    expect(readBotActingTurn([automationPrompt, report], lookups({}, THREAD)).originPlace).toBe(
      undefined
    )
    // Another thread in the same channel, or no place at all, never takes the thread's place.
    const mixed = { msg_a: THREAD, msg_b: OTHER }
    expect(readBotActingTurn([requestMail(['msg_a', 'msg_b'])], lookups(mixed)).originPlace).toBe(
      undefined
    )
    // Two comments on one issue are one place.
    const issue = (anchor: string): BotWakingPlace => ({
      source: 'github',
      placeId: 'acme/app#7',
      url: `https://github.com/acme/app/issues/7#issuecomment-${anchor}`
    })
    const comments = { msg_a: issue('1'), msg_b: issue('2') }
    expect(
      readBotActingTurn([requestMail(['msg_a', 'msg_b'])], lookups(comments)).originPlace
    ).toEqual(issue('1'))
    expect(
      readBotActingTurn([requestMail(['msg_a', 'msg_c'])], {
        ...lookups({ msg_a: THREAD }),
        isBotRequest: (id) => id === 'msg_a' || id === 'msg_c'
      }).originPlace
    ).toBe(undefined)
  })
})
