import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../bots/bot-session-tabs', () => ({ botOfSession: vi.fn() }))
vi.mock('../../../../external-conversations/external-conversation-chat', () => ({
  runtimeChatHost: vi.fn()
}))
vi.mock('../bots-chats', () => ({ readBotChats: vi.fn() }))

import type { AutomationBotTarget } from '../../../../../shared/automation-bot-target'
import {
  answerInOriginThread,
  namesThreadChannel,
  type CreatorThread
} from './answer-in-origin-thread'

const creator: CreatorThread = {
  sessionId: 'thread-chat',
  thread: {
    source: 'slack',
    externalId: 'T1:C08NLB8LXCP:1700000000.000100',
    place: '#ui-ux-design'
  }
}
const inThreadChat = {
  runsIn: 'chat',
  chat: { sessionId: 'thread-chat', homeIfGone: true, toConversation: true },
  resultsTo: 'chat',
  originThread: creator.thread
}
const base: AutomationBotTarget = { botId: 'b1', runsIn: 'new', resultsTo: 'chat' }

describe('an automation a thread turn makes answers under that thread', () => {
  it('runs a wait given --runs-in new and channel:<same channel> in the thread chat, with a note', () => {
    // The incident: a redo asked for in a thread was posted top-level in the same channel.
    const { target, note } = answerInOriginThread(
      { ...base, resultsTo: { channel: 'C08NLB8LXCP' } },
      creator,
      { runsInAsked: true }
    )
    expect(target).toEqual({ ...base, ...inThreadChat })
    expect(note).toBe(
      "Made while answering the Slack thread in #ui-ux-design, so it runs in this chat and replies there: this overrode --runs-in and --results-to (--results-to named this thread's own channel). To post in a different channel instead, name that channel with --results-to channel:<channel>."
    )
  })

  it('takes --results-to thread on a timed wait without a note', () => {
    const { target, note } = answerInOriginThread({ ...base, resultsTo: 'thread' }, creator, {
      runsInAsked: false
    })
    expect(target).toEqual({ ...base, ...inThreadChat })
    expect(note).toBeUndefined()
  })

  it('posts into the thread when it runs on its own agent', () => {
    const agentSetup: AutomationBotTarget['agentSetup'] = { agent: 'codex' }
    const { target } = answerInOriginThread({ ...base, agentSetup }, creator, { runsInAsked: true })
    expect(target).toEqual({
      ...base,
      agentSetup,
      resultsTo: 'thread',
      originThread: creator.thread
    })
  })

  it('keeps a different channel, an issue or none, remembering the thread for the post', () => {
    for (const resultsTo of [{ channel: 'C0OTHER' }, { linearIssue: 'ENG-1' }, 'none'] as const) {
      const { target, note } = answerInOriginThread({ ...base, resultsTo }, creator, {
        runsInAsked: true
      })
      expect(target).toEqual({ ...base, resultsTo, originThread: creator.thread })
      expect(note).toBeUndefined()
    }
  })

  it('keeps another chat chosen by id for a result that stays in Orca', () => {
    const chosen: AutomationBotTarget = { ...base, runsIn: 'chat', chat: { sessionId: 'other' } }
    expect(answerInOriginThread(chosen, creator, { runsInAsked: true }).target).toEqual({
      ...chosen,
      originThread: creator.thread
    })
  })
})

describe('the thread channel, as results may name it', () => {
  it.each([
    'C08NLB8LXCP',
    'c08nlb8lxcp',
    'slack:T1:C08NLB8LXCP',
    '#ui-ux-design',
    'ui-ux-design',
    'https://acme.slack.com/archives/C08NLB8LXCP/p1700000000000100'
  ])('matches %s', (channel) => {
    expect(namesThreadChannel(channel, creator.thread)).toBe(true)
  })

  it('does not match another channel', () => {
    expect(namesThreadChannel('C0OTHER', creator.thread)).toBe(false)
    expect(namesThreadChannel('#general', creator.thread)).toBe(false)
  })
})
